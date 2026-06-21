// Legal Notice (Mentions légales) — French LCEN art. 6-III + GDPR Art. 13
// publisher/host identification. Fill every [À CONFIRMER] field with the
// registered business identity BEFORE commercial launch.

export const metadata = {
  title: 'Legal Notice (Mentions légales) — MyFabmesh.AI',
  description: 'Publisher and host identification for MyFabmesh.AI.',
};

export default function LegalNoticePage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Legal Notice — Mentions légales</h1>
      <p style={{ color: 'var(--text-2)' }}>Last updated: 2026-06-20</p>

      <p>
        Pursuant to Article 6-III of the French Law for Confidence in the Digital
        Economy (LCEN n° 2004-575) and Article 13 GDPR, the following information
        identifies the publisher and the host of MyFabmesh.AI.
      </p>

      <h2>1. Publisher (Éditeur)</h2>
      <ul>
        <li><strong>Trade name:</strong> MyFabmesh.AI</li>
        <li><strong>Operator:</strong> Ayros Studio</li>
        <li><strong>Legal form:</strong> [À CONFIRMER — e.g. entrepreneur individuel / micro-entreprise / EURL / SASU]</li>
        <li><strong>SIREN / SIRET:</strong> [À CONFIRMER]</li>
        <li><strong>RCS / RM registration:</strong> [À CONFIRMER]</li>
        <li><strong>Share capital:</strong> [À CONFIRMER — only if a company]</li>
        <li><strong>Registered office:</strong> [À CONFIRMER — full postal address]</li>
        <li><strong>Intra-community VAT:</strong> [À CONFIRMER — or &ldquo;TVA non applicable, art. 293 B du CGI&rdquo; if under the franchise en base de TVA]</li>
        <li><strong>Director of publication (Directeur de la publication):</strong> [À CONFIRMER — e.g. Fabien Lacaze]</li>
        <li><strong>Contact:</strong> <a href="mailto:contact@myfabmesh.ai">contact@myfabmesh.ai</a> [À CONFIRMER — set up a professional mailbox]</li>
      </ul>

      <h2>2. Host (Hébergeur)</h2>
      <p>The site is served from the Cloudflare platform (Workers / Pages / R2):</p>
      <ul>
        <li><strong>Cloudflare, Inc.</strong></li>
        <li>101 Townsend Street, San Francisco, CA 94107, USA</li>
        <li><a href="https://www.cloudflare.com" target="_blank" rel="noopener">www.cloudflare.com</a></li>
      </ul>
      <p>
        GPU inference and data-processing sub-processors (full list in the{' '}
        <a href="/legal/privacy">Privacy Policy</a>): Modal Labs (GPU compute,
        USA), Supabase (database / authentication, EU region) and Stripe
        (payments).
      </p>

      <h2>3. Intellectual property</h2>
      <p>
        The MyFabmesh.AI brand, interface and source code are protected. The
        licences of the open-source models used to generate assets are listed on
        the <a href="/legal/licenses">Third-Party Licenses</a> page. Assets you
        generate belong to you under the terms set out in the{' '}
        <a href="/legal/terms">Terms of Service</a>.
      </p>

      <h2>4. Personal data</h2>
      <p>
        The data controller, lawful bases, your rights (access, rectification,
        erasure, portability) and how to exercise them are described in the{' '}
        <a href="/legal/privacy">Privacy Policy</a>. The supervisory authority for
        France is the CNIL (<a href="https://www.cnil.fr" target="_blank" rel="noopener">www.cnil.fr</a>).
      </p>

      <h2>5. Reporting &amp; takedowns</h2>
      <p>
        Copyright notices (DMCA / EU), illegal-content reports under the EU
        Digital Services Act (single point of contact) and the appeal process are
        detailed in sections 12–13 of the <a href="/legal/terms">Terms of
        Service</a>.
      </p>

      <h2>6. Consumer mediation</h2>
      <p>
        For consumers resident in the EU: in case of an unresolved dispute you may
        use the European Commission&apos;s Online Dispute Resolution platform at{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a>.
        The designated consumer mediator (médiateur de la consommation) is [À
        CONFIRMER — mandatory for B2C sales in France].
      </p>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/terms">Terms</a> &middot;{' '}
        <a href="/legal/privacy">Privacy</a> &middot;{' '}
        <a href="/legal/licenses">Third-Party Licenses</a> &middot;{' '}
        <a href="/">Home</a>
      </p>
    </main>
  );
}
