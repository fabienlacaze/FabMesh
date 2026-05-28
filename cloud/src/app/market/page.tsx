'use client';
//
// Public marketplace — anyone (logged in or not) can browse approved
// listings. Filter pills All / Free / Paid / Owned. Adding a paid
// item to the cart and clicking "Checkout" hits the Stripe-backed
// /api/market/checkout route; once paid, the user lands back on
// /market?paid=1 and sees the item in the "Owned" tab with a
// Download button.
//
import { useEffect, useState, Component, type ReactNode } from 'react';
import Script from 'next/script';

// Defensive error boundary — surfaces the next regression instead of the
// generic Next.js white screen + "client-side exception" overlay.
class MarketErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MarketPage] client error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: 'var(--text-1)', fontFamily: 'system-ui' }}>
          <h2>Something went wrong loading the marketplace.</h2>
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}
            className="primary-btn"
            style={{ padding: '8px 16px', marginTop: 12 }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Listing {
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
  author_display: string;
  user_id?: string;
  created_at: string;
  downloads: number;
  rating_avg?: number;
  rating_count?: number;
}

interface OwnedItem {
  id: string;
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  licence: string;
  asset_kind: string;
  asset_url: string;
  mesh_url: string;
  author_display: string;
  user_id?: string;
  created_at: string;
  rating_avg?: number;
  rating_count?: number;
}

const LICENCE_LABELS: Record<string, string> = {
  personal: 'Personal use',
  cc0: 'CC0 (public domain)',
  'cc-by': 'CC-BY 4.0',
  'cc-by-nc': 'CC-BY-NC 4.0',
  commercial: 'Royalty-free commercial',
};
const CART_KEY = 'mfm.market.cart';

function formatPrice(cents: number, currency: string): string {
  if (cents === 0) return 'Free';
  const amount = (cents / 100).toFixed(2);
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency + ' ';
  return symbol + amount;
}
function loadCart(): string[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
}
function saveCart(ids: string[]) {
  if (typeof window !== 'undefined') localStorage.setItem(CART_KEY, JSON.stringify(ids));
}

interface MineItem {
  listing_id: string;
  kind: 'mesh' | 'image';
  job_id: string | null;
  asset_url: string;
  mesh_url: string;
  status: string;
  price_cents: number;
  currency: string;
  title: string;
  description: string;
  licence: string;
  asset_type: string | null;
  author_display: string;
  user_id?: string;
  created_at: string;
  rejection_reason?: string;
  rating_avg?: number;
  rating_count?: number;
}

// Star rating display + interactive widget.
function Stars({
  value,
  count,
  size = 14,
  interactive = false,
  onRate,
}: {
  value: number;
  count?: number;
  size?: number;
  interactive?: boolean;
  onRate?: (n: number) => void;
}) {
  const [hover, setHover] = useState(0);
  const shown = interactive && hover > 0 ? hover : value;
  const stars = [1, 2, 3, 4, 5].map((i) => {
    const diff = shown - (i - 1);
    let fill = 0;
    if (diff >= 1) fill = 1;
    else if (diff > 0) fill = diff;
    const colorFull = '#ffc107';
    const colorEmpty = 'var(--text-3)';
    return (
      <span
        key={i}
        onClick={interactive ? (e) => { e.stopPropagation(); onRate?.(i); } : undefined}
        onMouseEnter={interactive ? () => setHover(i) : undefined}
        onMouseLeave={interactive ? () => setHover(0) : undefined}
        style={{
          position: 'relative',
          display: 'inline-block',
          fontSize: size,
          lineHeight: 1,
          cursor: interactive ? 'pointer' : 'default',
          color: colorEmpty,
        }}
        aria-label={interactive ? `Rate ${i} stars` : undefined}
      >
        <span style={{ color: colorEmpty }}>★</span>
        {fill > 0 && (
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: `${fill * 100}%`,
              overflow: 'hidden',
              color: colorFull,
              pointerEvents: 'none',
            }}
          >
            ★
          </span>
        )}
      </span>
    );
  });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ display: 'inline-flex', gap: 1 }}>{stars}</span>
      {typeof count === 'number' && (
        <span style={{ color: 'var(--text-3)', fontSize: Math.max(10, size - 3) }}>
          ({count})
        </span>
      )}
    </span>
  );
}

interface EditingDraft {
  listing_id: string;
  title: string;
  description: string;
  price_cents: number;
  licence: string;
}

export default function MarketPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [owned, setOwned] = useState<OwnedItem[]>([]);
  const [myListings, setMyListings] = useState<MineItem[]>([]);
  const [filtered, setFiltered] = useState<Listing[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'all' | 'free' | 'paid' | 'owned' | 'mine'>('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'mesh' | 'image'>('all');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [cart, setCart] = useState<string[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [paidBanner, setPaidBanner] = useState(false);
  const [editing, setEditing] = useState<EditingDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [meUserId, setMeUserId] = useState<string | null>(null);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [marketDisabled, setMarketDisabled] = useState(false);
  const [marketDisabledReason, setMarketDisabledReason] = useState<string | null>(null);
  const [flashListingId, setFlashListingId] = useState<string | null>(null);

  // First load
  useEffect(() => {
    setCart(loadCart());
    let deepLinkItem: string | null = null;
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search);
      if (q.get('paid') === '1') {
        setPaidBanner(true);
        // Successful checkout — clear the cart and switch to Owned.
        saveCart([]);
        setCart([]);
        setTab('owned');
      }
      deepLinkItem = q.get('item');
    }
    (async () => {
      try {
        const r = await fetch('/api/market/list');
        if (r.ok) {
          const j = await r.json();
          setListings(j.listings ?? []);
          if (j.marketplace_disabled) {
            setMarketDisabled(true);
            setMarketDisabledReason(j.marketplace_reason || null);
          }
        }
      } catch {}
      // Owned needs auth; silently 401 for anonymous users.
      try {
        const r = await fetch('/api/market/owned');
        if (r.ok) {
          const j = await r.json();
          setOwned(j.items ?? []);
        }
      } catch {}
      // My listings (every status the user has published). Silent 401.
      try {
        const r = await fetch('/api/me/published-assets');
        if (r.ok) {
          const j = await r.json();
          setMyListings(j.items ?? []);
        }
      } catch {}
      // Current user id (for hiding rate widget on own listings). Silent 401.
      try {
        const r = await fetch('/api/me');
        if (r.ok) {
          const j = await r.json();
          // handleMe returns { user: { id, email, ... } }. Fall back to
          // top-level id / user_id for older deploys.
          setMeUserId(j?.user?.id || j?.id || j?.user_id || null);
        }
      } catch {}
      // ?item=<id> deep link → open detail modal, then strip the param.
      if (deepLinkItem) {
        try {
          const r = await fetch(`/api/market/${encodeURIComponent(deepLinkItem)}`);
          if (r.ok) {
            const j = await r.json();
            const it: Listing | null = j?.listing ?? j ?? null;
            if (it && it.id) setSelected(it);
          }
        } catch {}
        if (typeof window !== 'undefined') {
          const u = new URL(window.location.href);
          u.searchParams.delete('item');
          window.history.replaceState({}, '', u.toString());
        }
      }
      setLoading(false);
    })();
  }, []);

  // Re-fetchable helper for after edit/remove on the "Mine" tab.
  async function refreshMyListings() {
    try {
      const r = await fetch('/api/me/published-assets');
      if (r.ok) {
        const j = await r.json();
        setMyListings(j.items ?? []);
      }
    } catch {}
  }

  useEffect(() => {
    const q = search.trim().toLowerCase();
    setFiltered(listings.filter((l) => {
      if (tab === 'free' && l.price_cents !== 0) return false;
      if (tab === 'paid' && l.price_cents === 0) return false;
      const kind = l.asset_kind || (l.mesh_url ? 'mesh' : 'image');
      if (kindFilter === 'mesh' && kind !== 'mesh') return false;
      if (kindFilter === 'image' && kind !== 'image') return false;
      if (q && !`${l.title} ${l.description} ${l.author_display}`.toLowerCase().includes(q)) return false;
      return true;
    }));
  }, [listings, search, tab, kindFilter]);

  const inCart = (id: string) => cart.includes(id);
  const addToCart = (id: string) => {
    if (inCart(id)) return;
    // Defensive: refuse to add one's own listing to the cart. The UI
    // should already hide the Add button, but a stale render or a
    // direct caller could still try.
    const l = listings.find((x) => x.id === id);
    if (l && meUserId && l.user_id === meUserId) {
      console.warn('[market] addToCart blocked: own listing', id);
      return;
    }
    const next = [...cart, id];
    setCart(next);
    saveCart(next);
  };
  const removeFromCart = (id: string) => {
    const next = cart.filter((x) => x !== id);
    setCart(next);
    saveCart(next);
  };

  const cartItems = listings.filter((l) => cart.includes(l.id));
  const cartTotal = cartItems.reduce((sum, l) => sum + l.price_cents, 0);

  // Click a cart row → close the drawer, open the listing detail
  // modal, and flash the corresponding grid card for 1s. If the
  // listing isn't on the current tab (e.g. we're in Owned but the
  // listing is paid-not-owned), still open the detail modal — the
  // grid flash is best-effort.
  function openListingFromCart(l: Listing) {
    setCartOpen(false);
    setTab('all');           // make sure the card lives in the current view
    setKindFilter('all');    // and isn't hidden by the kind filter
    setSelected(l);
    setFlashListingId(l.id);
    // Scroll the matching card into view if it exists in the DOM.
    setTimeout(() => {
      const el = document.querySelector(`[data-listing-card="${l.id}"]`);
      if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 30);
    // Auto-clear the flash after 1s.
    setTimeout(() => setFlashListingId((cur) => cur === l.id ? null : cur), 1000);
  }

  async function checkout() {
    if (!cart.length) return;
    setCheckingOut(true);
    try {
      const r = await fetch('/api/market/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ listing_ids: cart }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          window.location.href = '/login?next=/market';
          return;
        }
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      if (j?.url) {
        window.location.href = j.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert('Checkout failed: ' + msg);
      setCheckingOut(false);
    }
  }

  const ownedIds = new Set(owned.map((o) => o.id));

  // Display list = filtered listings for All/Free/Paid, or `owned`
  // mapped into the same shape for the "Owned" tab, or `myListings`
  // mapped into the same shape for the "Mine" tab.
  const kindMatch = (k: string | undefined | null) => {
    const eff = k || 'mesh';
    if (kindFilter === 'mesh' && eff !== 'mesh') return false;
    if (kindFilter === 'image' && eff !== 'image') return false;
    return true;
  };
  const displayItems: Listing[] = tab === 'owned'
    ? owned.filter((o) => kindMatch(o.asset_kind)).map((o) => ({
        id: o.id, title: o.title, description: o.description,
        price_cents: o.price_cents, currency: o.currency, licence: o.licence,
        asset_kind: (o.asset_kind as 'mesh' | 'image' | undefined) || 'mesh',
        asset_type: null,
        asset_url: o.asset_url, mesh_url: o.mesh_url,
        author_display: o.author_display, user_id: o.user_id,
        created_at: o.created_at,
        downloads: 0,
        rating_avg: o.rating_avg, rating_count: o.rating_count,
      }))
    : tab === 'mine'
    ? myListings.filter((m) => kindMatch(m.kind)).map((m) => ({
        id: m.listing_id, title: m.title, description: m.description,
        price_cents: m.price_cents, currency: m.currency, licence: m.licence,
        asset_kind: m.kind, asset_type: m.asset_type,
        asset_url: m.asset_url, mesh_url: m.mesh_url,
        author_display: m.author_display, user_id: m.user_id,
        created_at: m.created_at,
        downloads: 0,
        rating_avg: m.rating_avg, rating_count: m.rating_count,
      }))
    : filtered;

  // Quick lookup for status badges on the "Mine" tab.
  const mineById = new Map(myListings.map((m) => [m.listing_id, m]));

  async function handleRemoveMine(id: string) {
    if (!confirm('Remove this listing from the marketplace?')) return;
    try {
      const r = await fetch(`/api/market/unpublish/${id}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      await refreshMyListings();
    } catch (e: unknown) {
      alert('Remove failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  function openEdit(m: MineItem) {
    setEditing({
      listing_id: m.listing_id,
      title: m.title,
      description: m.description,
      price_cents: m.price_cents,
      licence: m.licence || 'personal',
    });
  }

  async function rateListing(listingId: string, stars: number) {
    if (ratingBusy) return;
    setRatingBusy(true);
    try {
      const r = await fetch(`/api/market/listing/${listingId}/rate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ stars }),
      });
      if (!r.ok) {
        if (r.status === 401) {
          window.location.href = '/login?next=/market';
          return;
        }
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = await r.json().catch(() => ({}));
      const newAvg: number | undefined = j?.rating_avg;
      const newCount: number | undefined = j?.rating_count;
      if (typeof newAvg === 'number' && typeof newCount === 'number') {
        setListings((prev) => prev.map((l) => l.id === listingId
          ? { ...l, rating_avg: newAvg, rating_count: newCount }
          : l));
        setOwned((prev) => prev.map((o) => o.id === listingId
          ? { ...o, rating_avg: newAvg, rating_count: newCount }
          : o));
        setSelected((s) => (s && s.id === listingId)
          ? { ...s, rating_avg: newAvg, rating_count: newCount }
          : s);
      }
    } catch (e: unknown) {
      alert('Rating failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRatingBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.title.trim()) { alert('Title is required.'); return; }
    setSavingEdit(true);
    try {
      const r = await fetch(`/api/market/listing/${editing.listing_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: editing.title,
          description: editing.description,
          price_cents: editing.price_cents,
          licence: editing.licence,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      setEditing(null);
      await refreshMyListings();
    } catch (e: unknown) {
      alert('Save failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="page">
      <Script
        src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"
        type="module" strategy="afterInteractive"
      />
      <div className="page-header" style={{ alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
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
          style={{ padding: '8px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-0)', minWidth: 200, fontSize: 13 }}
        />
        {/* Cart trigger — visible when there is at least one item */}
        <button
          onClick={() => setCartOpen(true)}
          className="primary-btn"
          style={{ padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: 8, position: 'relative' }}
        >
          🛒 Cart
          {cart.length > 0 && (
            <span style={{ background: '#fff', color: '#000', borderRadius: 999, padding: '0 8px', fontSize: 12, fontWeight: 800 }}>
              {cart.length}
            </span>
          )}
        </button>
      </div>

      {marketDisabled && (
        <div style={{ background: 'rgba(244,67,54,0.15)', border: '1px solid var(--err)', color: '#ff6b6b', padding: '10px 14px', borderRadius: 8, marginBottom: 18, fontSize: 13 }}>
          🔴 <strong>Marketplace temporarily disabled.</strong>{marketDisabledReason ? ` Reason: ${marketDisabledReason}` : ''} Browsing only — purchasing and publishing are paused.
        </div>
      )}
      {paidBanner && (
        <div style={{ background: 'rgba(76,175,80,0.15)', border: '1px solid var(--ok)', color: 'var(--ok)', padding: '10px 14px', borderRadius: 8, marginBottom: 18, fontSize: 13 }}>
          ✓ Payment received — your purchase is in the <strong>Owned</strong> tab below.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {(['all', 'mesh', 'image'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={kindFilter === k ? 'primary-btn' : 'ghost-btn'}
            style={{ padding: '6px 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {k === 'all' ? '🎴 All kinds'
              : k === 'mesh' ? '🧊 3D Meshes'
              : '🖼 2D Images'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {(['all', 'free', 'paid', 'owned', 'mine'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setTab(p)}
            className={tab === p ? 'primary-btn' : 'ghost-btn'}
            style={{ padding: '6px 16px', fontSize: 13, textTransform: 'capitalize', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {p === 'all' ? 'All'
              : p === 'free' ? 'Free'
              : p === 'paid' ? 'Paid'
              : p === 'owned' ? '✓ Owned'
              : '📝 Mine'}
            {p === 'owned' && owned.length > 0 && (
              <span style={{ background: 'var(--ok)', color: '#fff', borderRadius: 999, padding: '0 7px', fontSize: 11, fontWeight: 700 }}>
                {owned.length}
              </span>
            )}
            {p === 'mine' && myListings.length > 0 && (
              <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: 999, padding: '0 7px', fontSize: 11, fontWeight: 700 }}>
                {myListings.length}
              </span>
            )}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', color: 'var(--text-2)', fontSize: 12, alignSelf: 'center' }}>
          {loading ? 'Loading…' : `${displayItems.length} listing${displayItems.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {!loading && displayItems.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-2)' }}>
          {tab === 'owned'
            ? <>No purchases yet. Browse <a onClick={() => setTab('all')} style={{ color: 'var(--accent)', cursor: 'pointer' }}>All listings →</a></>
            : tab === 'mine'
            ? <>You haven&apos;t published anything yet. <a href="/app/" style={{ color: 'var(--accent)' }}>Open the app to publish a mesh →</a></>
            : <>No listings match your filters yet. <a href="/app/" style={{ color: 'var(--accent)' }}>Publish your first mesh →</a></>}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {displayItems.map((l) => {
            const kind = l.asset_kind || (l.mesh_url ? 'mesh' : 'image');
            const url = l.asset_url || l.mesh_url;
            const owns = ownedIds.has(l.id);
            const isFlashing = flashListingId === l.id;
            return (
              <div
                key={l.id}
                data-listing-card={l.id}
                onClick={() => setSelected(l)}
                style={{
                  background: 'var(--bg-1)',
                  border: isFlashing ? '2px solid #ffc107' : '1px solid var(--border)',
                  boxShadow: isFlashing ? '0 0 0 4px rgba(255,193,7,0.35)' : 'none',
                  borderRadius: 10, overflow: 'hidden', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column',
                  transition: 'transform 0.15s, border-color 0.15s, box-shadow 0.25s',
                }}
                onMouseEnter={(e) => { if (!isFlashing) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; } }}
                onMouseLeave={(e) => { if (!isFlashing) { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; } }}
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
                  <div style={{ color: 'var(--text-2)', fontSize: 11 }}>
                    {l.user_id ? (
                      <a
                        href={`/market/author?id=${encodeURIComponent(l.user_id)}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'none' }}
                      >
                        by {l.author_display}
                      </a>
                    ) : (
                      <>by {l.author_display}</>
                    )}
                    {' · '}{kind === 'image' ? '2D image' : (l.asset_type || '3D mesh')}
                  </div>
                  <div style={{ color: 'var(--text-3)', fontSize: 10 }}>
                    {LICENCE_LABELS[l.licence] || l.licence}
                  </div>
                  <div>
                    <Stars value={l.rating_avg ?? 0} count={l.rating_count ?? 0} size={13} />
                  </div>
                  {tab === 'mine' ? (() => {
                    const m = mineById.get(l.id);
                    const status = m?.status || 'pending';
                    const statusColor =
                      status === 'approved' ? 'var(--ok)'
                      : status === 'rejected' ? 'var(--err)'
                      : '#ffcc66';
                    const statusBg =
                      status === 'approved' ? 'rgba(76,175,80,0.18)'
                      : status === 'rejected' ? 'rgba(244,67,54,0.18)'
                      : 'rgba(255,200,80,0.18)';
                    return (
                      <>
                        <div style={{ display: 'inline-block', alignSelf: 'flex-start', background: statusBg, color: statusColor, padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>
                          {status}
                        </div>
                        {status === 'rejected' && m?.rejection_reason && (
                          <div style={{ color: 'var(--err)', fontSize: 10, fontStyle: 'italic' }}>
                            {m.rejection_reason}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); if (m) openEdit(m); }}
                            className="ghost-btn"
                            style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
                          >
                            ✏ Edit
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRemoveMine(l.id); }}
                            className="ghost-btn"
                            style={{ flex: 1, padding: '6px 8px', fontSize: 12, color: 'var(--err)' }}
                          >
                            ✗ Remove
                          </button>
                        </div>
                      </>
                    );
                  })() : owns ? (
                    <a
                      href={`/api/market/download/${l.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="primary-btn"
                      style={{ marginTop: 6, padding: '6px 12px', fontSize: 12, textAlign: 'center', textDecoration: 'none' }}
                    >
                      ⬇ Download
                    </a>
                  ) : l.price_cents === 0 ? (
                    <a
                      href={l.asset_url || l.mesh_url}
                      download
                      onClick={(e) => e.stopPropagation()}
                      className="ghost-btn"
                      style={{ marginTop: 6, padding: '6px 12px', fontSize: 12, textAlign: 'center', textDecoration: 'none' }}
                    >
                      ⬇ Free download
                    </a>
                  ) : (meUserId && l.user_id === meUserId) ? (
                    <span
                      style={{
                        marginTop: 6,
                        padding: '6px 12px',
                        fontSize: 12,
                        textAlign: 'center',
                        background: 'var(--bg-2)',
                        color: 'var(--text-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                      }}
                    >
                      Your listing
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); inCart(l.id) ? removeFromCart(l.id) : addToCart(l.id); }}
                      className={inCart(l.id) ? 'ghost-btn' : 'primary-btn'}
                      style={{ marginTop: 6, padding: '6px 12px', fontSize: 12 }}
                    >
                      {inCart(l.id) ? '✓ In cart — remove' : '🛒 Add to cart'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, maxWidth: 720, width: '100%', maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>{selected.title}</h2>
                <div style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 4 }}>
                  {selected.user_id ? (
                    <a
                      href={`/market/author?id=${encodeURIComponent(selected.user_id)}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'none' }}
                    >
                      by {selected.author_display}
                    </a>
                  ) : (
                    <>by {selected.author_display}</>
                  )}
                  {selected.asset_type ? ` · ${selected.asset_type}` : ''} · {LICENCE_LABELS[selected.licence] || selected.licence}
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="ghost-btn" style={{ padding: '4px 12px' }}>✕</button>
            </div>
            {(() => {
              const kind = selected.asset_kind || (selected.mesh_url ? 'mesh' : 'image');
              const url = selected.asset_url || selected.mesh_url;
              return kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={selected.title} style={{ width: '100%', maxHeight: 480, objectFit: 'contain', background: '#0a0a0e', borderRadius: 8 }} />
              ) : (
                // @ts-expect-error model-viewer is a custom element
                <model-viewer src={url} camera-controls auto-rotate shadow-intensity="1" exposure="1" style={{ width: '100%', height: 420, background: '#0a0a0e', borderRadius: 8 }} />
              );
            })()}
            {selected.description && (
              <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-1)', fontSize: 13, lineHeight: 1.5, margin: 0 }}>{selected.description}</p>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Stars value={selected.rating_avg ?? 0} count={selected.rating_count ?? 0} size={18} />
                {typeof selected.rating_avg === 'number' && selected.rating_count ? (
                  <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
                    {selected.rating_avg.toFixed(1)} / 5
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>No ratings yet</span>
                )}
              </div>
              {meUserId && selected.user_id !== meUserId && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                  <span style={{ color: 'var(--text-2)', fontSize: 12 }}>Your rating:</span>
                  <Stars
                    value={0}
                    size={20}
                    interactive
                    onRate={(n) => rateListing(selected.id, n)}
                  />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{formatPrice(selected.price_cents, selected.currency)}</div>
              {ownedIds.has(selected.id) ? (
                <a href={`/api/market/download/${selected.id}`} className="primary-btn" style={{ padding: '10px 24px', textDecoration: 'none' }}>
                  ⬇ Download
                </a>
              ) : selected.price_cents === 0 ? (
                <a href={selected.asset_url || selected.mesh_url} download className="primary-btn" style={{ padding: '10px 24px', textDecoration: 'none' }}>
                  ⬇ Free download
                </a>
              ) : (meUserId && selected.user_id === meUserId) ? (
                <span
                  style={{
                    padding: '10px 24px',
                    background: 'var(--bg-2)',
                    color: 'var(--text-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  Your listing
                </span>
              ) : (
                <button
                  onClick={() => inCart(selected.id) ? removeFromCart(selected.id) : addToCart(selected.id)}
                  className={inCart(selected.id) ? 'ghost-btn' : 'primary-btn'}
                  style={{ padding: '10px 24px' }}
                >
                  {inCart(selected.id) ? '✓ In cart — remove' : '🛒 Add to cart'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cart drawer */}
      {cartOpen && (
        <div onClick={() => setCartOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'flex-end', zIndex: 101 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '95vw', height: '100%', background: 'var(--bg-1)', borderLeft: '1px solid var(--border)', padding: 24, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>🛒 Cart</h2>
              <button onClick={() => setCartOpen(false)} className="ghost-btn" style={{ padding: '4px 12px' }}>✕</button>
            </div>
            {cartItems.length === 0 ? (
              <p style={{ color: 'var(--text-2)', fontSize: 13 }}>Your cart is empty. Add paid listings from the grid.</p>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                  {cartItems.map((l) => (
                    <div
                      key={l.id}
                      onClick={() => openListingFromCart(l)}
                      style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                      title="Click to inspect on the marketplace"
                    >
                      {l.asset_kind === 'image' ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={l.asset_url || l.mesh_url} alt="" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6, background: '#0a0a0e' }} />
                      ) : (
                        <div style={{ width: 60, height: 60, background: '#0a0a0e', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>🧊</div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.title}</div>
                        <div style={{ color: 'var(--text-2)', fontSize: 11 }}>{LICENCE_LABELS[l.licence] || l.licence}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{formatPrice(l.price_cents, l.currency)}</div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFromCart(l.id); }}
                        className="ghost-btn"
                        style={{ padding: '4px 10px', fontSize: 12, color: 'var(--err)' }}
                      >✕</button>
                    </div>
                  ))}
                </div>
                <div style={{ paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                    <span>Total</span>
                    <strong>{formatPrice(cartTotal, cartItems[0]?.currency || 'USD')}</strong>
                  </div>
                  <button onClick={checkout} disabled={checkingOut} className="primary-btn" style={{ padding: '12px', fontSize: 14 }}>
                    {checkingOut ? 'Redirecting to Stripe…' : `Checkout with Stripe`}
                  </button>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center' }}>
                    Secure payment via Stripe · 30% platform fee covers infrastructure + commission · sellers receive 70% net.
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Edit modal for "Mine" listings */}
      {editing && (
        <div onClick={() => !savingEdit && setEditing(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 102 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, maxWidth: 540, width: '100%', maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>✏ Edit listing</h2>
              <button onClick={() => setEditing(null)} disabled={savingEdit} className="ghost-btn" style={{ padding: '4px 12px' }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              Saving changes resets the listing to <strong>pending</strong> so an admin can re-review it.
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
              Title
              <input
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                maxLength={120}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-0)', fontSize: 14 }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
              Description
              <textarea
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                maxLength={2000}
                rows={5}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-0)', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
              Price (cents — set 0 for free)
              <input
                type="number"
                min={0}
                step={1}
                value={editing.price_cents}
                onChange={(e) => setEditing({ ...editing, price_cents: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-0)', fontSize: 14 }}
              />
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Preview: {formatPrice(editing.price_cents, 'USD')}
              </div>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
              Licence
              <select
                value={editing.licence}
                onChange={(e) => setEditing({ ...editing, licence: e.target.value })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-0)', fontSize: 14 }}
              >
                {Object.entries(LICENCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setEditing(null)} disabled={savingEdit} className="ghost-btn" style={{ padding: '8px 16px' }}>Cancel</button>
              <button onClick={saveEdit} disabled={savingEdit} className="primary-btn" style={{ padding: '8px 20px' }}>
                {savingEdit ? 'Saving…' : 'Save changes'}
              </button>
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
