// Third-Party Licenses — open-source + pretrained-model attributions.
// Renders the repo-root THIRD_PARTY_LICENSES.txt at build time so the
// "Built with DINOv3" / Apache attribution links (which point here) resolve
// and the OpenRAIL / Stability / Apache notice requirements are satisfied.

import fs from 'fs';
import path from 'path';

export const metadata = {
  title: 'Licences des composants tiers — MyFabmesh.AI',
  description:
    'Licences et attributions des logiciels open source et des modèles d’IA pré-entraînés utilisés par MyFabmesh.AI.',
};

function loadLicenses(): string {
  // The build runs from cloud/; the canonical file lives at the repo root.
  const candidates = [
    path.join(process.cwd(), '..', 'THIRD_PARTY_LICENSES.txt'),
    path.join(process.cwd(), 'THIRD_PARTY_LICENSES.txt'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* try next candidate */
    }
  }
  return 'Le fichier complet des licences des composants tiers est disponible dans le dépôt source, sous le nom THIRD_PARTY_LICENSES.txt.';
}

export default function LicensesPage() {
  const text = loadLicenses();
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '32px 24px', lineHeight: 1.6 }}>
      <h1>Licences et attributions des composants tiers</h1>
      <p style={{ color: 'var(--text-2)' }}>
        MyFabmesh.AI repose sur des logiciels open source et des modèles
        d&rsquo;IA pré-entraînés. Les textes de licence et les attributions
        requises pour chaque composant fourni avec le produit ou téléchargé à
        l&rsquo;exécution sont reproduits ci-dessous, dans leur langue
        d&rsquo;origine. En particulier, ce produit porte la mention{' '}
        <strong>Built with DINOv3</strong> et utilise le rastériseur Kaolin
        sous licence Apache-2.0 (jamais le backend nvdiffrast, dont la licence
        est non commerciale).
      </p>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 13,
          background: 'var(--bg-2, #0e0e14)',
          color: 'var(--text-1, #d8d8e0)',
          padding: 16,
          borderRadius: 8,
          overflowX: 'auto',
          marginTop: 24,
        }}
      >
        {text}
      </pre>
    </main>
  );
}
