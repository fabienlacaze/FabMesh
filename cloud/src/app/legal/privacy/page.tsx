// Privacy Policy — GDPR-compliant baseline for the EU launch.
// Tailored to MyFabmesh.AI's actual data flows (Supabase auth, Stripe
// payments, Cloudflare R2 storage, Modal GPU compute, Replicate API).
// Edit before launch with your registered business name / address.

export const metadata = {
  title: 'Privacy Policy — MyFabmesh.AI',
  description: 'How MyFabmesh.AI collects, stores, and uses your personal data.',
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Privacy Policy</h1>
      <p style={{ color: 'var(--text-2)' }}>Last updated: 2026-05-27</p>

      <p>
        This page explains what personal data MyFabmesh.AI (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;) collects when you use the service at{' '}
        <code>myfabmesh-cloud.fabien65400.workers.dev</code>, why we collect it, how
        long we keep it, and how to exercise your GDPR rights.
      </p>

      <h2>1. Data controller</h2>
      <p>
        MyFabmesh.AI — operated by Fabien Lacaze, France. Contact for any
        privacy request: <a href="mailto:fabien65400@hotmail.fr">fabien65400@hotmail.fr</a>.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li>
          <strong>Account data:</strong> email address and password hash, stored
          by our authentication provider <strong>Supabase</strong> (EU region).
        </li>
        <li>
          <strong>Generated assets:</strong> images and 3D meshes you produce,
          stored on <strong>Cloudflare R2</strong> under a key prefixed with
          your anonymous user id.
        </li>
        <li>
          <strong>Generation history:</strong> the parameters of each job (asset
          type, mode, seed, options, timestamps, credit cost) stored in our
          Supabase database.
        </li>
        <li>
          <strong>Payment data:</strong> handled by <strong>Stripe</strong>. We
          never see your card number; we only store the Stripe session id, the
          credit pack purchased, and the amount in EUR.
        </li>
        <li>
          <strong>Technical data:</strong> IP address (transient, used only for
          rate-limiting), user-agent string, and short-lived Cloudflare access
          logs.
        </li>
      </ul>

      <h2>3. Why we collect it</h2>
      <ul>
        <li>To authenticate you (legitimate interest + contractual necessity).</li>
        <li>To run the generation pipeline you requested (contractual necessity).</li>
        <li>To bill you for credits used (contractual necessity).</li>
        <li>To protect the service from abuse — rate-limiting, ban lists, audit logs (legitimate interest).</li>
        <li>To comply with French and EU law where applicable (legal obligation).</li>
      </ul>

      <h2>4. Third parties we share data with</h2>
      <p>We don&apos;t sell your data. We share strictly what each provider needs:</p>
      <ul>
        <li><strong>Supabase</strong> (Auth + Postgres, EU region) — your account and jobs.</li>
        <li><strong>Stripe</strong> — your payment session.</li>
        <li><strong>Cloudflare</strong> — Worker, R2 storage, CDN.</li>
        <li><strong>Modal Labs</strong> — GPU compute for image / mesh generation. Receives the source image you uploaded for the duration of the job.</li>
        <li><strong>Replicate</strong> — fallback GPU compute. Same scope as Modal.</li>
      </ul>

      <h2>5. How long we keep your data</h2>
      <ul>
        <li>Account + payment history: until you delete your account (GDPR Art. 17 — see below).</li>
        <li>Generated R2 assets: until you delete them, or until your account is deleted.</li>
        <li>Admin audit logs: 12 months.</li>
        <li>Cloudflare technical logs: 24 hours (Cloudflare default).</li>
      </ul>

      <h2>6. Your rights (GDPR)</h2>
      <ul>
        <li>
          <strong>Right to access (Art. 15):</strong> log in and visit{' '}
          <a href="/account">/account</a> → &ldquo;Download my data&rdquo; for a
          full JSON export of everything we hold.
        </li>
        <li>
          <strong>Right to erasure (Art. 17):</strong> log in and visit{' '}
          <a href="/account">/account</a> → &ldquo;Delete my account&rdquo;. We
          will permanently delete your account, projects, meshes, images and
          payment history within seconds. The operation is logged but the
          deleted data itself is unrecoverable.
        </li>
        <li>
          <strong>Right to rectification (Art. 16):</strong> change your email
          or password from /account, or email us.
        </li>
        <li>
          <strong>Right to data portability (Art. 20):</strong> covered by the
          JSON export above.
        </li>
        <li>
          <strong>Right to lodge a complaint:</strong> contact the CNIL
          (France) at <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener">cnil.fr/fr/plaintes</a>.
        </li>
      </ul>

      <h2>7. Cookies</h2>
      <p>
        We use two strictly necessary cookies and no tracking cookies:
      </p>
      <ul>
        <li><code>mfm-session</code> — HttpOnly, holds your access token while signed in.</li>
        <li><code>mfm-refresh</code> — HttpOnly, used to mint a new access token before the current one expires.</li>
      </ul>
      <p>
        Stripe sets its own cookies on its own domain when you check out.
        Cloudflare may set anti-bot cookies (<code>__cf_bm</code>) at the edge.
        Neither is under our control.
      </p>

      <h2>8. NSFW / illegal content</h2>
      <p>
        Generating, uploading or sharing content that is illegal in the
        country of either party (notably CSAM and other content prohibited
        by French law) terminates your account immediately. We cooperate
        with authorities when required by law.
      </p>

      <h2>9. Changes</h2>
      <p>
        We update this page when our practices change. The &ldquo;Last
        updated&rdquo; date at the top reflects the current version. Material
        changes are announced by email to active users.
      </p>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/terms">Terms of Service</a> &middot;{' '}
        <a href="/">Home</a>
      </p>
    </main>
  );
}
