// Legal Notice (Mentions légales) — French LCEN art. 6-III + GDPR Art. 13
// publisher/host identification. Fill every [À_COMPLÉTER: …] field with the
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
      <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
        This is the single source of truth for the operator&apos;s legal identity.
        Every legal / commercial page (Terms, Privacy, checkout receipts) must
        reference the same values as below.
      </p>
      <ul>
        <li><strong>Trade name:</strong> MyFabmesh.AI</li>
        <li><strong>Operator:</strong> Ayros Studio</li>
        <li><strong>Legal form:</strong> [À_COMPLÉTER: forme juridique — ex. entrepreneur individuel / micro-entreprise / EURL / SASU]</li>
        <li><strong>SIREN / SIRET:</strong> [À_COMPLÉTER: SIREN 9 chiffres / SIRET 14 chiffres]</li>
        <li><strong>RCS / RM registration:</strong> [À_COMPLÉTER: n° RCS ou RM + ville d&apos;immatriculation]</li>
        <li><strong>Share capital:</strong> [À_COMPLÉTER: capital social — uniquement si société ; sinon « sans objet »]</li>
        <li><strong>Registered office:</strong> [À_COMPLÉTER: adresse postale complète du siège — valeur unique reprise à l&apos;identique sur toutes les pages légales]</li>
        <li><strong>Intra-community VAT:</strong> [À_COMPLÉTER: n° TVA intracommunautaire — ou « TVA non applicable, art. 293 B du CGI » si franchise en base de TVA]</li>
        <li><strong>Director of publication (Directeur de la publication):</strong> [À_COMPLÉTER: nom du directeur de la publication — ex. Fabien Lacaze]</li>
        <li><strong>Contact:</strong> <a href="mailto:contact@myfabmesh.ai">contact@myfabmesh.ai</a> [À_COMPLÉTER: confirmer/créer la boîte professionnelle]</li>
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

      <h2>6. Consumer mediation (Médiateur de la consommation)</h2>
      <p>
        In accordance with Article L612-1 of the French Consumer Code, any
        consumer has the right to free recourse to a consumer mediator with a view
        to the amicable resolution of a dispute with a trader. Before referring a
        matter to the mediator, the consumer must first have submitted a written
        complaint to us (see contact above).
      </p>
      <ul>
        <li><strong>Designated consumer mediator (médiateur agréé):</strong> [À_COMPLÉTER: médiateur agréé — ex. CM2C / Medicys — nom, adresse postale, site web]</li>
        <li><strong>Mediator postal &amp; web contact:</strong> [À_COMPLÉTER: coordonnées complètes du médiateur (adresse + URL de saisine en ligne)]</li>
      </ul>
      <p>
        For consumers resident in the EU, the European Commission also provides an
        Online Dispute Resolution platform at{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a>.
        Recourse to mediation is optional; the consumer remains free to bring the
        matter before the competent courts.
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
