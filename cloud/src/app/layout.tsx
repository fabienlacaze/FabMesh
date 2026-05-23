import './globals.css';
import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'MyFabmesh.AI Cloud — Image to 3D',
  description: 'Generate game-ready 3D meshes from a single image. Cloud GPUs, no local install required.',
  openGraph: {
    title: 'MyFabmesh.AI Cloud',
    description: 'Image → 3D mesh in 90 s. Pay-as-you-go, no install.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Nav />
        <main>{children}</main>
        <footer style={{ borderTop: '1px solid var(--line)', padding: '40px 0', marginTop: 80 }}>
          <div className="container" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div className="muted" style={{ fontSize: 13 }}>
              © 2026 FabWare · MyFabmesh.AI <span className="beta-badge">BETA</span>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
              <a href="/legal/terms" className="muted">Conditions</a>
              <a href="/legal/privacy" className="muted">Confidentialité</a>
              <a href="https://fabienlacaze.github.io/MyFabmesh" target="_blank" className="muted">Desktop app</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
