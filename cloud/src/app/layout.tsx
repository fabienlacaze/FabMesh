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
        <footer className="site-footer">
          <div>
            © 2026 FabWare · MyFabmesh.AI <span className="pill" style={{ marginLeft: 6 }}>BETA</span>
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <a href="/legal/terms">Terms</a>
            <a href="/legal/privacy">Privacy</a>
            <a href="https://fabienlacaze.github.io/MyFabmesh" target="_blank">Desktop app</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
