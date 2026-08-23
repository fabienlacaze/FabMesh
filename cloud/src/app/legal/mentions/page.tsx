// Legal Notice (Mentions légales) — French LCEN art. 6-III + GDPR Art. 13
// publisher/host identification. The registered business identity is defined
// ONCE in @/config/legal-identity and imported here — fill it there.

import { legalIdentity as id } from '@/config/legal-identity';

export const metadata = {
  title: 'Mentions légales — MyFabmesh.AI',
  description: "Identification de l'éditeur et de l'hébergeur de MyFabmesh.AI.",
};

export default function LegalNoticePage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Mentions légales</h1>
      <p style={{ color: 'var(--text-2)' }}>Dernière mise à jour : 2026-06-20</p>

      <p>
        En application de l&apos;article 6-III de la loi pour la confiance dans
        l&apos;économie numérique (LCEN n° 2004-575) et de l&apos;article 13 du
        RGPD, les informations ci-dessous identifient l&apos;éditeur et
        l&apos;hébergeur de MyFabmesh.AI.
      </p>

      <h2>1. Éditeur</h2>
      <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
        Cette page constitue la source unique de vérité de l&apos;identité légale
        de l&apos;exploitant. Toute page légale ou commerciale (conditions
        générales, politique de confidentialité, reçus de paiement) doit reprendre
        les mêmes valeurs que ci-dessous.
      </p>
      <ul>
        <li><strong>Nom commercial :</strong> {id.tradeName}</li>
        <li><strong>Exploitant :</strong> {id.operator}</li>
        <li><strong>Forme juridique :</strong> {id.legalForm}</li>
        <li><strong>SIREN / SIRET :</strong> {id.siret}</li>
        <li><strong>Immatriculation RCS / RM :</strong> {id.rcs}</li>
        <li><strong>Capital social :</strong> {id.shareCapital}</li>
        <li><strong>Siège social :</strong> {id.registeredOffice}</li>
        <li><strong>TVA intracommunautaire :</strong> {id.vatNumber}</li>
        <li><strong>Directeur de la publication :</strong> {id.publicationDirector}</li>
        <li><strong>Contact :</strong> <a href={`mailto:${id.contactEmail}`}>{id.contactEmail}</a></li>
      </ul>

      <h2>2. Hébergeur</h2>
      <p>Le site est hébergé sur la plateforme Cloudflare (Workers / Pages / R2) :</p>
      <ul>
        <li><strong>{id.host.name}</strong></li>
        <li>{id.host.address}</li>
        <li><a href={id.host.url} target="_blank" rel="noopener">{id.host.url.replace(/^https?:\/\//, '')}</a></li>
      </ul>
      <p>
        Sous-traitants d&apos;inférence GPU et de traitement des données (liste
        complète dans la{' '}
        <a href="/legal/privacy">politique de confidentialité</a>) : Modal Labs
        (calcul GPU, États-Unis), Supabase (base de données / authentification,
        région UE) et Stripe (paiements).
      </p>

      <h2>3. Propriété intellectuelle</h2>
      <p>
        La marque, l&apos;interface et le code source de MyFabmesh.AI sont
        protégés. Les licences des modèles open source utilisés pour générer les
        créations sont listées sur la page{' '}
        <a href="/legal/licenses">Licences tierces</a>. Les créations que vous
        générez vous appartiennent dans les conditions prévues par les{' '}
        <a href="/legal/terms">conditions générales</a>.
      </p>

      <h2>4. Données à caractère personnel</h2>
      <p>
        Le responsable de traitement, les bases légales, vos droits (accès,
        rectification, effacement, portabilité) et leurs modalités d&apos;exercice
        sont décrits dans la{' '}
        <a href="/legal/privacy">politique de confidentialité</a>. L&apos;autorité
        de contrôle compétente pour la France est la CNIL
        (<a href="https://www.cnil.fr" target="_blank" rel="noopener">www.cnil.fr</a>).
      </p>

      <h2>5. Signalements &amp; retraits</h2>
      <p>
        Les notifications relatives au droit d&apos;auteur (DMCA / UE), les
        signalements de contenus illicites au titre du règlement européen sur les
        services numériques (Digital Services Act — point de contact unique) et la
        procédure de recours sont détaillés aux sections 12 et 13 des{' '}
        <a href="/legal/terms">conditions générales</a>.
      </p>

      <h2>6. Médiation de la consommation</h2>
      <p>
        Conformément à l&apos;article L612-1 du code de la consommation, tout
        consommateur a le droit de recourir gratuitement à un médiateur de la
        consommation en vue de la résolution amiable d&apos;un litige
        l&apos;opposant à un professionnel. Avant de saisir le médiateur, le
        consommateur doit avoir préalablement adressé une réclamation écrite
        auprès de nous (voir le contact ci-dessus).
      </p>
      <ul>
        <li><strong>Médiateur de la consommation désigné (médiateur agréé) :</strong> {id.mediator.name}</li>
        <li><strong>Coordonnées postales &amp; en ligne du médiateur :</strong> {id.mediator.postalAddress} — <a href={id.mediator.url} target="_blank" rel="noopener">{id.mediator.url}</a></li>
      </ul>
      <p>
        Pour les consommateurs résidant dans l&apos;Union européenne, la
        Commission européenne met également à disposition une plateforme de
        règlement en ligne des litiges à l&apos;adresse{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a>.
        Le recours à la médiation est facultatif ; le consommateur reste libre de
        porter le litige devant les juridictions compétentes.
      </p>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/terms">Conditions générales</a> &middot;{' '}
        <a href="/legal/privacy">Confidentialité</a> &middot;{' '}
        <a href="/legal/licenses">Licences tierces</a> &middot;{' '}
        <a href="/">Accueil</a>
      </p>
    </main>
  );
}
