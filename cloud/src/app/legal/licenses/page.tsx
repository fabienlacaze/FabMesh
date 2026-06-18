// Third-Party Licenses — open-source + pretrained-model attributions.
// Renders the repo-root THIRD_PARTY_LICENSES.txt at build time so the
// "Built with DINOv3" / Apache attribution links (which point here) resolve
// and the OpenRAIL / Stability / Apache notice requirements are satisfied.

import fs from 'fs';
import path from 'path';

export const metadata = {
  title: 'Third-Party Licenses — MyFabmesh.AI',
  description:
    'Open-source software and pretrained AI model licenses and attributions used by MyFabmesh.AI.',
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
  return 'The full third-party license file is available in the source repository at THIRD_PARTY_LICENSES.txt.';
}

export default function LicensesPage() {
  const text = loadLicenses();
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '32px 24px', lineHeight: 1.6 }}>
      <h1>Third-Party Licenses &amp; Attributions</h1>
      <p style={{ color: 'var(--text-2)' }}>
        MyFabmesh.AI is built with open-source software and pretrained AI models.
        The license texts and required attributions for every bundled or
        runtime-downloaded component are reproduced below. Notably, this product
        is <strong>Built with DINOv3</strong>, and uses the Apache-2.0 Kaolin
        rasterizer (never the non-commercial nvdiffrast backend).
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
