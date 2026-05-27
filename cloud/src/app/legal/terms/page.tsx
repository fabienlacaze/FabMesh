// Terms of Service — baseline tailored to MyFabmesh.AI's actual flows.
// Replace the placeholder business identity before launch.

export const metadata = {
  title: 'Terms of Service — MyFabmesh.AI',
  description: 'The terms that govern your use of MyFabmesh.AI.',
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Terms of Service</h1>
      <p style={{ color: 'var(--text-2)' }}>Last updated: 2026-05-27</p>

      <p>
        By creating an account on MyFabmesh.AI (operated by{' '}
        <strong>Ayros Studio</strong>, France), you accept these terms.
        If you don&apos;t accept them, don&apos;t create an account.
        Contact: <a href="mailto:fabien65400@hotmail.fr">fabien65400@hotmail.fr</a>.
      </p>

      <h2>1. The service</h2>
      <p>
        MyFabmesh.AI lets you generate images and 3D meshes via AI models
        running on third-party GPU infrastructure (Modal Labs, Replicate).
        You pay with prepaid credits or a monthly subscription, both
        processed by Stripe.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>You must be at least 16 years old (or the legal age of digital consent in your country).</li>
        <li>One account per person. No account sharing.</li>
        <li>You are responsible for keeping your password secret. We&apos;ll never ask you for it.</li>
        <li>Suspicious activity (brute-force, credential sharing, automated scraping) is grounds for immediate suspension.</li>
      </ul>

      <h2>3. Credits and subscriptions</h2>
      <ul>
        <li>One-shot credit packs (Starter / Pro / Studio) never expire.</li>
        <li>Monthly subscriptions auto-renew until you cancel them. Credits from a subscription month do not roll over.</li>
        <li>Refunds: prepaid credits are non-refundable once they have been spent. Unspent credits are refundable within 14 days of purchase for EU buyers (right of withdrawal — Code de la consommation Art. L221-18 et seq.), unless you have already started consuming them.</li>
        <li>Pricing is shown on <a href="/buy">/buy</a> and can change with 30 days&apos; notice. Prior purchases keep their original credit values.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree NOT to:</p>
      <ul>
        <li>Generate, upload or share illegal content — notably CSAM, content that infringes other people&apos;s rights, or anything else prohibited by French law.</li>
        <li>Attempt to bypass quotas, rate-limits, NSFW filters or any other safety mechanism.</li>
        <li>Probe the infrastructure for vulnerabilities without our written authorization (see <em>Responsible disclosure</em> below).</li>
        <li>Resell access to your account.</li>
      </ul>

      <h2>5. Intellectual property</h2>
      <ul>
        <li><strong>What you upload</strong> belongs to you. You grant us a non-exclusive, royalty-free licence to store it, route it to GPU providers, and process it on your behalf — strictly to provide the service. We don&apos;t train models on your inputs.</li>
        <li><strong>What you generate</strong> is yours under the licence the underlying model allows. TRELLIS-2, RealVis, FLUX, SDXL all currently allow commercial use. You can use the outputs commercially. We claim no rights on them.</li>
        <li><strong>Our brand, code and UI</strong> are ours. You can&apos;t copy them.</li>
      </ul>

      <h2>6. Service availability</h2>
      <p>
        We aim for high availability but don&apos;t promise 24/7 uptime.
        Generations can fail; when that happens we refund the credits
        automatically. We may suspend the service at any time for
        maintenance, security incidents, or to enforce these terms — see
        the admin kill switches in our privacy / security model.
      </p>

      <h2>7. Termination</h2>
      <ul>
        <li>You can delete your account at any time from <a href="/account">/account</a>. All your data is wiped within seconds.</li>
        <li>We can suspend or terminate accounts that violate these terms or pose a security/legal risk. Unused credits on a terminated account are refunded except when the termination is for fraud or abuse.</li>
      </ul>

      <h2>8. Liability</h2>
      <p>
        To the maximum extent allowed by French law: the service is
        provided &ldquo;as is&rdquo;. We&apos;re not liable for indirect
        damages (lost profits, lost data, missed opportunities). Our total
        liability over a 12-month period is capped at the total amount
        you paid us during that period.
      </p>

      <h2>9. Responsible disclosure</h2>
      <p>
        If you find a security vulnerability, please email{' '}
        <a href="mailto:fabien65400@hotmail.fr">fabien65400@hotmail.fr</a>{' '}
        with the details. We&apos;ll acknowledge within 48 hours, work with
        you on a fix, and credit you on a public thank-you page if you
        want. Don&apos;t exploit, don&apos;t exfiltrate other users&apos; data,
        don&apos;t publish before the fix is live.
      </p>

      <h2>10. Governing law</h2>
      <p>
        These terms are governed by French law. Any dispute that
        can&apos;t be resolved amicably falls under the jurisdiction of
        the French courts.
      </p>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/privacy">Privacy Policy</a> &middot;{' '}
        <a href="/">Home</a>
      </p>
    </main>
  );
}
