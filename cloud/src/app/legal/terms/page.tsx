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
      <p style={{ color: 'var(--text-2)' }}>Last updated: 2026-06-20</p>

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
        <li>All consumer prices are shown <strong>inclusive of tax (TTC)</strong>. Any applicable VAT is included and computed according to your country of residence.</li>
      </ul>

      <h2>3a. Right of withdrawal &amp; digital content (EU consumers)</h2>
      <ul>
        <li>
          <strong>Principle.</strong> As an EU consumer you normally have 14 days to
          withdraw from a distance purchase without giving a reason (Code de la
          consommation Art. L221-18 et seq.). Unspent, unused credits are refundable
          within that period.
        </li>
        <li>
          <strong>Waiver for immediately-supplied digital content
          (Art. L221-28 13°).</strong> Credits are digital content usable
          immediately, and generated assets are digital content supplied on a
          non-tangible medium as soon as you launch a generation. By purchasing and
          by ticking the consent box at checkout, you{' '}
          <strong>expressly request that performance begin immediately</strong> and
          you <strong>acknowledge that you thereby lose your right of withdrawal</strong>{' '}
          in respect of any credit you have started to consume and of any asset
          already generated (Art. L221-28 13° of the Code de la consommation).
        </li>
        <li>
          <strong>What remains refundable.</strong> Credits that you have neither
          spent nor started to consume remain refundable within the 14-day period.
        </li>
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
        <li><strong>AI-generated content &amp; transparency.</strong> All images and 3D assets produced by the service are generated by artificial intelligence. In line with the EU AI Act (Art. 50), generated images are marked with machine-readable provenance metadata (IPTC <code>DigitalSourceType=trainedAlgorithmicMedia</code>). If you generate the likeness of a real, identifiable person, you are solely responsible for holding the necessary rights and for any disclosure obligations applicable to such content.</li>
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

      <h2>10a. Consumer mediation (Médiateur de la consommation)</h2>
      <p>
        In accordance with Article L612-1 of the French Consumer Code, after
        first sending us a written complaint, any consumer may refer the dispute
        free of charge to the designated consumer mediator:
      </p>
      <ul>
        <li><strong>Designated consumer mediator:</strong> [À_COMPLÉTER: médiateur agréé — ex. CM2C / Medicys — nom, adresse postale, URL de saisine]</li>
      </ul>
      <p>
        EU consumers may also use the European Commission&apos;s Online Dispute
        Resolution platform at{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a>.
        The full mediator coordinates are also listed in the{' '}
        <a href="/legal/mentions">Legal Notice (Mentions légales)</a>.
      </p>

      <h2>11. Marketplace</h2>

      <h3>11.1 Publishing assets</h3>
      <ul>
        <li>Users may publish meshes and images they generated on the platform to the Marketplace.</li>
        <li>Each listing is reviewed by an administrator before becoming visible to buyers.</li>
        <li>The author retains ownership of their creation; publishing grants the platform a non-exclusive right to display the asset and process sales.</li>
        <li>Authors guarantee that their submission does not infringe any third-party rights.</li>
        <li>Authors can choose between five licences (Personal use, CC0, CC-BY 4.0, CC-BY-NC 4.0, Royalty-free commercial). The licence is attached to the asset on download.</li>
        <li>An administrator may at any time reject or remove a listing that breaches these terms.</li>
      </ul>

      <h3>11.2 Buying assets</h3>
      <ul>
        <li>Free listings are downloadable immediately by any signed-in user after approval.</li>
        <li>Paid listings are bought via Stripe Checkout. Buyers receive a non-exclusive licence under the terms attached to the asset.</li>
        <li>Buyers may NOT redistribute, resell, or sublicense purchased assets unless the chosen licence (CC0, CC-BY, commercial) explicitly allows it.</li>
        <li>Refunds are handled case-by-case via support; contact us within 14 days of purchase with a clear reason.</li>
      </ul>

      <h3>11.3 Commission and payouts</h3>
      <ul>
        <li>The platform takes a 30% commission on every paid sale. The seller receives 70% net.</li>
        <li>Sellers can opt to receive their share either as platform credits (instant, +20% bonus over cash equivalent) or as cash via Stripe Connect (after KYC onboarding handled by Stripe).</li>
        <li>Cash payouts are settled by Stripe directly to the seller&apos;s linked bank account on the Stripe payout schedule.</li>
        <li>Sellers using Stripe Connect agree to Stripe&apos;s <a href="https://stripe.com/connect-account/legal">Connected Account Agreement</a>.</li>
        <li>The platform is not responsible for delays caused by Stripe verification, banking holidays, or KYC issues.</li>
      </ul>

      <h3>11.4 Taxes</h3>
      <ul>
        <li>Sellers are responsible for declaring and paying any taxes (VAT, income tax) due in their jurisdiction on their marketplace earnings.</li>
        <li>The platform may report seller activity to tax authorities where required (US 1099-K reporting via Stripe above the IRS threshold; EU DAC7 above the EUR 2000 / 30-sales annual threshold).</li>
      </ul>

      <h3>11.5 Disputes</h3>
      <ul>
        <li>Disputes between buyer and seller (asset quality, licence interpretation) should first be brought to platform support.</li>
        <li>The platform may mediate and, if appropriate, refund the buyer or sanction the seller.</li>
        <li>Chargebacks initiated by buyers via their bank are handled by Stripe; the platform may withhold the disputed amount from the seller&apos;s pending balance until resolution.</li>
      </ul>

      <h2>12. Copyright &amp; takedown (DMCA / EU)</h2>
      <p>
        We respect intellectual property and respond to valid notices of claimed
        infringement under the U.S. DMCA (17 U.S.C. §512) and the EU Copyright
        Directive / French LCEN.
      </p>
      <h3>12.1 Filing a notice</h3>
      <p>
        If you believe content on MyFabmesh.AI (a generated asset, a marketplace
        listing, or an uploaded image) infringes your copyright, email{' '}
        <a href="mailto:fabien65400@hotmail.fr">fabien65400@hotmail.fr</a> with the
        subject &ldquo;Copyright notice&rdquo; and include: identification of the
        copyrighted work and of the infringing material (with a URL or listing
        ID); your contact details; a statement that you have a good-faith belief
        the use is not authorised; a statement, under penalty of perjury, that the
        information is accurate and that you are the rights holder or authorised to
        act for them; and your physical or electronic signature. We will remove or
        disable access to the reported material expeditiously and notify the
        uploader.
      </p>
      <h3>12.2 Counter-notice</h3>
      <p>
        If your content was removed and you believe this was a mistake or
        misidentification, send a counter-notice to the same address with the
        identification of the removed material, your contact details, a statement
        under penalty of perjury that the removal was a mistake, and your
        signature. We may restore the material unless the original claimant
        initiates legal action.
      </p>
      <h3>12.3 Repeat infringers</h3>
      <p>
        Accounts that repeatedly infringe third-party rights are suspended or
        terminated.
      </p>

      <h2>13. Reporting illegal content (EU Digital Services Act)</h2>
      <p>
        Under the EU Digital Services Act (Regulation 2022/2065), anyone can
        notify us of content they consider illegal.
      </p>
      <ul>
        <li>
          <strong>How to report:</strong> use the &ldquo;Report&rdquo; control on a
          marketplace listing, or email{' '}
          <a href="mailto:fabien65400@hotmail.fr">fabien65400@hotmail.fr</a> with
          the subject &ldquo;Illegal content&rdquo;, an explanation of why the
          content is illegal, and its location (URL or listing ID).
        </li>
        <li>
          <strong>Point of contact:</strong> the address above is our single point
          of contact for users and authorities (DSA Art. 11–12).
        </li>
        <li>
          <strong>Our action:</strong> we review every notice, remove or disable
          content that is illegal or breaches these terms, and inform the affected
          user with a <em>statement of reasons</em> (DSA Art. 17).
        </li>
        <li>
          <strong>Appeal:</strong> if your content or account is restricted, you
          may contest the decision by replying to the statement of reasons; a
          human re-examines the case.
        </li>
        <li>
          <strong>Illegal content is never allowed</strong> — in particular CSAM,
          terrorist content, and content infringing others&apos; rights. We
          cooperate with the competent authorities and report offences where the
          law requires it.
        </li>
      </ul>
      <h3>13.1 Designated agents</h3>
      <ul style={{ fontSize: 14 }}>
        <li><strong>DSA single point of contact &amp; copyright / DMCA agent:</strong> [À_COMPLÉTER: nom de l&apos;agent désigné], reachable at <a href="mailto:contact@myfabmesh.ai">contact@myfabmesh.ai</a>. Before distributing to U.S. users, this agent must also be registered with the U.S. Copyright Office DMCA Designated Agent Directory.</li>
        <li><strong>Registered business identity</strong> (operator, SIRET, registered office, host): see the <a href="/legal/mentions">Legal Notice (Mentions légales)</a>.</li>
      </ul>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/privacy">Privacy Policy</a> &middot;{' '}
        <a href="/legal/licenses">Third-Party Licenses</a> &middot;{' '}
        <a href="/">Home</a>
      </p>
    </main>
  );
}
