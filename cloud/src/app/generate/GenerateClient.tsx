'use client';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'lite' | 'standard' | 'full';
type AssetType = 'character' | 'creature' | 'vehicle' | 'building' | 'weapon' | 'prop' | 'environment' | 'icon' | 'custom';

interface Props {
  initialCredits: number;
  isLoggedIn: boolean;
}

export function GenerateClient({ initialCredits, isLoggedIn }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [assetType, setAssetType] = useState<AssetType>('character');
  const [mode, setMode] = useState<Mode>('standard');
  const [opts, setOpts] = useState({ rectify: true, back_view: true, smooth: true, face_fix: false, ultra_hd: false, fast: false });
  const [seed, setSeed] = useState(42);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [meshUrl, setMeshUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const cost = (() => {
    let n = mode === 'lite' ? 1 : mode === 'standard' ? 1 : 2;
    if (opts.fast) n += 1;
    if (opts.ultra_hd) n += 1;
    if (opts.face_fix) n += 1;
    return n;
  })();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isLoggedIn) { router.push('/login?next=/generate'); return; }
    if (!file) { setError('Choisis une image.'); return; }
    if (cost > initialCredits) { setError(`Crédits insuffisants (${initialCredits} dispo, ${cost} requis).`); return; }

    setBusy(true);
    setProgress('Upload de l\'image…');

    const fd = new FormData();
    fd.append('image', file);
    fd.append('asset_type', assetType);
    fd.append('mode', mode);
    fd.append('seed', String(seed));
    for (const [k, v] of Object.entries(opts)) fd.append(k, String(v));

    try {
      const res = await fetch('/api/generate', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const { jobId } = await res.json();
      setProgress('Génération en cours… (~90 s)');
      await pollJob(jobId);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pollJob(jobId: string) {
    const start = Date.now();
    while (Date.now() - start < 600_000) { // 10 min max
      await new Promise(r => setTimeout(r, 3000));
      const r = await fetch(`/api/jobs/${jobId}`);
      const j = await r.json();
      if (j.status === 'succeeded') {
        setMeshUrl(j.url);
        setProgress(`Terminé en ${j.duration_s?.toFixed(0)} s`);
        return;
      }
      if (j.status === 'failed' || j.status === 'canceled') {
        throw new Error(j.error || 'Génération échouée');
      }
      setProgress(`${j.status}… (${Math.round((Date.now() - start) / 1000)} s)`);
    }
    throw new Error('Timeout');
  }

  return (
    <form onSubmit={onSubmit} className="grid-2" style={{ gap: 24 }}>
      {/* LEFT — inputs */}
      <div className="card">
        <label>Image de référence</label>
        <div
          ref={dropRef}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
          style={{ border: '2px dashed var(--line-strong)', borderRadius: 'var(--radius-sm)', padding: 20, textAlign: 'center', cursor: 'pointer', minHeight: 200 }}
          onClick={() => (dropRef.current?.querySelector('input[type=file]') as HTMLInputElement)?.click()}
        >
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ display: 'none' }} />
          {preview ? (
            <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 6 }} />
          ) : (
            <div>
              <div style={{ fontSize: 36, marginBottom: 8 }}>📁</div>
              <div className="muted">Glisse-dépose ou clique pour choisir</div>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>PNG / JPG / WEBP — fond uni recommandé</div>
            </div>
          )}
        </div>

        <label style={{ marginTop: 16 }}>Type d'asset</label>
        <select value={assetType} onChange={(e) => setAssetType(e.target.value as AssetType)} style={{ width: '100%' }}>
          <option value="character">Personnage</option>
          <option value="creature">Créature</option>
          <option value="vehicle">Véhicule</option>
          <option value="building">Bâtiment</option>
          <option value="weapon">Arme</option>
          <option value="prop">Prop / objet</option>
          <option value="environment">Environnement</option>
          <option value="icon">Icône</option>
          <option value="custom">Autre</option>
        </select>

        <label style={{ marginTop: 16 }}>Qualité</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['lite', 'standard', 'full'] as Mode[]).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={mode === m ? '' : 'ghost'} style={{ flex: 1, fontSize: 13 }}>
              {m === 'lite' ? 'Lite' : m === 'standard' ? 'Standard' : 'Full'}
            </button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          {mode === 'lite' && '~60 s · voxel 1024 · 100k tris · 1 crédit'}
          {mode === 'standard' && '~90 s · voxel 1024 · 500k tris · 1 crédit'}
          {mode === 'full' && '~180 s · voxel 1536 cascade · 1.5M tris · 2 crédits'}
        </div>

        <label style={{ marginTop: 16 }}>Options</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 14 }}>
          {([
            ['rectify', 'Auto-rectify (front canonique)'],
            ['back_view', 'Back-view (perso/créature)'],
            ['smooth', 'Texture smooth'],
            ['face_fix', 'Face fix (+1 crédit)'],
            ['ultra_hd', 'Ultra HD 8K (+1 crédit)'],
            ['fast', 'Fast mode H100 (+1 crédit)'],
          ] as [keyof typeof opts, string][]).map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>

        <label style={{ marginTop: 16 }}>Seed</label>
        <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value) || 42)} />

        <div style={{ marginTop: 20, padding: 14, background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13 }} className="muted">Coût total</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{cost} crédit{cost > 1 ? 's' : ''}</div>
          </div>
          <button type="submit" disabled={busy || !file}>
            {busy ? 'Génération…' : 'Générer'}
          </button>
        </div>
        {error && <div style={{ color: 'var(--bad)', marginTop: 12, fontSize: 14 }}>⚠ {error}</div>}
      </div>

      {/* RIGHT — viewer */}
      <div className="card" style={{ minHeight: 540, display: 'flex', flexDirection: 'column' }}>
        <h3>Résultat</h3>
        {!meshUrl && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', textAlign: 'center', gap: 8 }}>
            <div style={{ fontSize: 48 }}>📦</div>
            <div className="muted">{progress || 'Aucun mesh généré pour l\'instant'}</div>
          </div>
        )}
        {meshUrl && (
          <>
            <ModelViewer src={meshUrl} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <a href={meshUrl} download>
                <button className="ghost">⬇ Télécharger GLB</button>
              </a>
              <button type="button" onClick={() => setMeshUrl(null)} className="ghost">Effacer</button>
            </div>
          </>
        )}
      </div>
    </form>
  );
}

function ModelViewer({ src }: { src: string }) {
  useEffect(() => {
    if (!document.querySelector('script[data-mv]')) {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = 'https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js';
      s.setAttribute('data-mv', '1');
      document.head.appendChild(s);
    }
  }, []);
  // @ts-expect-error - custom element
  return <model-viewer
    src={src}
    camera-controls
    auto-rotate
    exposure="1.2"
    shadow-intensity="0.5"
    environment-image="neutral"
    style={{ flex: 1, width: '100%', minHeight: 400, background: '#1a1f2b', borderRadius: 8 }}
  />;
}
