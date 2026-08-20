// Privacy Policy — GDPR-compliant baseline for the EU launch.
// Tailored to MyFabmesh.AI's actual data flows (Supabase auth, Stripe
// payments, Cloudflare R2 storage, Modal GPU compute, Replicate API).
// The data-controller identity is defined ONCE in @/config/legal-identity.

import { legalIdentity as id } from '@/config/legal-identity';

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
        {id.tradeName} is operated by <strong>{id.operator}</strong> ({id.country}).
        Contact for any privacy request:{' '}
        <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a>.
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
        <li>
          <strong>Diagnostic logs — off unless you turn them on:</strong> the app
          keeps a rolling copy of your browser console in memory. It is
          <strong> never sent anywhere</strong> unless you tick &ldquo;Send
          diagnostic logs to MyFabmesh&rdquo; in Settings, which you would
          normally only do because support asked you to. When enabled, the log
          — which includes your prompts, your project names, the page address
          and your browser&apos;s user-agent — is uploaded after each
          generation. Passwords, access tokens and e-mail addresses are
          stripped out before it leaves your browser. It is kept for 30 days,
          then deleted automatically. Turning the switch back off stops it
          immediately, and Settings also offers &ldquo;Save a copy
          instead&rdquo;, which writes the same log to a file on your computer
          and uploads nothing.
        </li>
      </ul>

      <h2>3. Why we collect it</h2>
      <ul>
        <li>To authenticate you (legitimate interest + contractual necessity).</li>
        <li>To run the generation pipeline you requested (contractual necessity).</li>
        <li>To bill you for credits used (contractual necessity).</li>
        <li>To protect the service from abuse — rate-limiting, ban lists, audit logs (legitimate interest).</li>
        <li>To investigate a problem you reported, if — and only if — you switched diagnostic logs on (consent, Art. 6(1)(a); withdraw it by switching them back off).</li>
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
        <li>Diagnostic logs (only if you enabled them): 30 days, then deleted automatically.</li>
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

      <h2>10. Marketplace &amp; Stripe Connect</h2>
      <p>
        If you list assets on our marketplace, or activate cash payouts as a
        seller, the following additional terms apply.
      </p>

      <h3>10.1 Data we collect from marketplace participants</h3>
      <ul>
        <li>
          <strong>Listing metadata</strong> (title, description, price, licence)
          is stored in our backend and visible to all marketplace visitors once
          approved.
        </li>
        <li>
          <strong>Author display name</strong> (derived from the part of your
          email before the <code>@</code>) is shown next to your listings.
        </li>
        <li>
          <strong>Sales records</strong> (buyer ID, seller ID, amount, currency,
          Stripe session ID, <code>paid_at</code> timestamp, payout details) are
          stored for accounting and audit purposes.
        </li>
      </ul>

      <h3>10.2 Data shared with Stripe (sellers who activate cash payouts)</h3>
      <ul>
        <li>
          When you click &ldquo;Set up cash payouts&rdquo;, you are redirected
          to <strong>Stripe Connect Express</strong> where you provide
          identification data (name, address, date of birth, ID document,
          IBAN / bank account).
        </li>
        <li>
          Stripe performs KYC (&ldquo;Know Your Customer&rdquo;) verification
          under European AML directives or the US Bank Secrecy Act, as
          applicable.
        </li>
        <li>
          We do <strong>not</strong> store your ID document, full bank account
          number, or date of birth. Stripe is the data controller for that
          data.
        </li>
        <li>
          We do store: Stripe account ID (<code>acct_xxx</code>), country,
          <code> charges_enabled</code> / <code>payouts_enabled</code> flags,
          and account creation date.
        </li>
        <li>
          Stripe&apos;s privacy policy applies to that data:{' '}
          <a href="https://stripe.com/privacy" target="_blank" rel="noopener">stripe.com/privacy</a>.
        </li>
      </ul>

      <h3>10.3 Tax reporting</h3>
      <ul>
        <li>
          Where required by law (US IRS 1099-K thresholds, EU DAC7 thresholds),
          we may share aggregated sales data with tax authorities through
          Stripe&apos;s reporting tools.
        </li>
        <li>
          Sellers will be notified by Stripe if their activity reaches a
          reportable threshold.
        </li>
      </ul>

      <h3>10.4 Your rights</h3>
      <ul>
        <li>
          You can request deletion of your seller account at any time. Stripe
          will retain transactional records for the legal minimum (typically
          7&ndash;10 years for accounting).
        </li>
        <li>
          Active listings are unpublished automatically when the seller account
          is deleted.
        </li>
        <li>
          Sales records older than 30 days are not deleted, in order to comply
          with accounting law.
        </li>
      </ul>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/terms">Terms of Service</a> &middot;{' '}
        <a href="/">Home</a>
      </p>
    </main>
  );
}
