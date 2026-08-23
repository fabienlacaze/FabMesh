// Privacy Policy — GDPR-compliant baseline for the EU launch.
// Tailored to MyFabmesh.AI's actual data flows (Supabase auth, Stripe
// payments, Cloudflare R2 storage, Modal GPU compute, Replicate API).
// The data-controller identity is defined ONCE in @/config/legal-identity.

import { legalIdentity as id } from '@/config/legal-identity';

export const metadata = {
  title: 'Politique de confidentialité — MyFabmesh.AI',
  description: 'Comment MyFabmesh.AI collecte, conserve et utilise vos données personnelles.',
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Politique de confidentialité</h1>
      <p style={{ color: 'var(--text-2)' }}>Dernière mise à jour&nbsp;: 2026-05-27</p>

      <p>
        Cette page explique quelles données à caractère personnel MyFabmesh.AI
        (&laquo;&nbsp;nous&nbsp;&raquo;) collecte lorsque vous utilisez le service à
        l&apos;adresse{' '}
        <code>myfabmesh-cloud.fabien65400.workers.dev</code>, pourquoi nous les
        collectons, combien de temps nous les conservons, et comment exercer vos
        droits issus du RGPD.
      </p>

      <h2>1. Responsable du traitement</h2>
      <p>
        {id.tradeName} est exploité par <strong>{id.operator}</strong> ({id.country}).
        Contact pour toute demande relative à la protection des données&nbsp;:{' '}
        <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a>.
      </p>

      <h2>2. Données que nous collectons</h2>
      <ul>
        <li>
          <strong>Données de compte&nbsp;:</strong> adresse e-mail et empreinte
          (hash) du mot de passe, conservées par notre prestataire
          d&apos;authentification <strong>Supabase</strong> (région UE).
        </li>
        <li>
          <strong>Contenus générés&nbsp;:</strong> les images et les maillages 3D
          que vous produisez, stockés sur <strong>Cloudflare R2</strong> sous une
          clé préfixée par votre identifiant utilisateur anonyme.
        </li>
        <li>
          <strong>Historique de génération&nbsp;:</strong> les paramètres de chaque
          tâche (type d&apos;asset, mode, seed, options, horodatages, coût en
          crédits), stockés dans notre base de données Supabase.
        </li>
        <li>
          <strong>Données de paiement&nbsp;:</strong> traitées par{' '}
          <strong>Stripe</strong>. Nous ne voyons jamais votre numéro de carte&nbsp;;
          nous conservons uniquement l&apos;identifiant de session Stripe, le pack
          de crédits acheté et le montant en EUR.
        </li>
        <li>
          <strong>Données techniques&nbsp;:</strong> adresse IP (transitoire,
          utilisée uniquement pour la limitation de débit), chaîne user-agent et
          journaux d&apos;accès Cloudflare de courte durée.
        </li>
        <li>
          <strong>
            Journaux de diagnostic &mdash; désactivés sauf si vous les activez&nbsp;:
          </strong>{' '}
          l&apos;application conserve en mémoire une copie glissante de la console
          de votre navigateur. Elle n&apos;est
          <strong> jamais transmise nulle part</strong> à moins que vous ne cochiez
          &laquo;&nbsp;Send diagnostic logs to MyFabmesh&nbsp;&raquo; (envoyer les
          journaux de diagnostic à MyFabmesh) dans &laquo;&nbsp;Settings&nbsp;&raquo; (Réglages), ce que vous ne
          feriez normalement que parce que le support vous l&apos;a demandé. Une
          fois l&apos;option activée, le journal &mdash; qui contient vos prompts,
          les noms de vos projets, l&apos;adresse de la page et le user-agent de
          votre navigateur &mdash; est téléversé après chaque génération. Les mots
          de passe, les jetons d&apos;accès et les adresses e-mail en sont retirés
          avant qu&apos;il ne quitte votre navigateur. Il est conservé 30 jours,
          puis supprimé automatiquement. Remettre l&apos;interrupteur en position
          désactivée arrête l&apos;envoi immédiatement, et &laquo;&nbsp;Settings&nbsp;&raquo; propose
          également &laquo;&nbsp;Save a copy instead&nbsp;&raquo; (enregistrer
          plutôt une copie), qui écrit le même journal dans un fichier sur votre
          ordinateur et ne téléverse rien.
        </li>
      </ul>

      <h2>3. Pourquoi nous les collectons</h2>
      <ul>
        <li>Pour vous authentifier (intérêt légitime + exécution du contrat).</li>
        <li>Pour exécuter le pipeline de génération que vous avez demandé (exécution du contrat).</li>
        <li>Pour vous facturer les crédits consommés (exécution du contrat).</li>
        <li>Pour protéger le service contre les abus &mdash; limitation de débit, listes de bannissement, journaux d&apos;audit (intérêt légitime).</li>
        <li>Pour instruire un problème que vous nous avez signalé, si &mdash; et seulement si &mdash; vous avez activé les journaux de diagnostic (consentement, art. 6.1.a&nbsp;; retirez-le en les désactivant).</li>
        <li>Pour nous conformer au droit français et au droit de l&apos;Union européenne lorsqu&apos;ils s&apos;appliquent (obligation légale).</li>
      </ul>

      <h2>4. Tiers avec lesquels nous partageons des données</h2>
      <p>Nous ne vendons pas vos données. Nous ne partageons que ce dont chaque prestataire a strictement besoin&nbsp;:</p>
      <ul>
        <li><strong>Supabase</strong> (Auth + Postgres, région UE) &mdash; votre compte et vos tâches.</li>
        <li><strong>Stripe</strong> &mdash; votre session de paiement.</li>
        <li><strong>Cloudflare</strong> &mdash; Worker, stockage R2, CDN.</li>
        <li><strong>Modal Labs</strong> &mdash; calcul GPU pour la génération d&apos;images / de maillages. Reçoit l&apos;image source que vous avez téléversée, pour la durée de la tâche.</li>
        <li><strong>Replicate</strong> &mdash; calcul GPU de secours. Même périmètre que Modal.</li>
      </ul>

      <h2>5. Durée de conservation de vos données</h2>
      <ul>
        <li>Compte + historique de paiement&nbsp;: jusqu&apos;à ce que vous supprimiez votre compte (art. 17 du RGPD &mdash; voir ci-dessous).</li>
        <li>Contenus générés stockés sur R2&nbsp;: jusqu&apos;à ce que vous les supprimiez, ou jusqu&apos;à la suppression de votre compte.</li>
        <li>Journaux d&apos;audit de l&apos;administration&nbsp;: 12 mois.</li>
        <li>Journaux de diagnostic (uniquement si vous les avez activés)&nbsp;: 30 jours, puis suppression automatique.</li>
        <li>Journaux techniques Cloudflare&nbsp;: 24 heures (valeur par défaut de Cloudflare).</li>
      </ul>

      <h2>6. Vos droits (RGPD)</h2>
      <ul>
        <li>
          <strong>Droit d&apos;accès (art. 15)&nbsp;:</strong> connectez-vous et rendez-vous sur{' '}
          <a href="/account">/account</a> → &laquo;&nbsp;Download my data&nbsp;&raquo;
          (télécharger mes données) pour obtenir un export JSON complet de tout ce
          que nous détenons.
        </li>
        <li>
          <strong>Droit à l&apos;effacement (art. 17)&nbsp;:</strong> connectez-vous et rendez-vous sur{' '}
          <a href="/account">/account</a> → &laquo;&nbsp;Delete my account&nbsp;&raquo;
          (supprimer mon compte). Nous supprimerons définitivement votre compte,
          vos projets, vos maillages, vos images et votre historique de paiement en
          quelques secondes. L&apos;opération est journalisée, mais les données
          supprimées elles-mêmes sont irrécupérables.
        </li>
        <li>
          <strong>Droit de rectification (art. 16)&nbsp;:</strong> modifiez votre
          adresse e-mail ou votre mot de passe depuis /account, ou écrivez-nous.
        </li>
        <li>
          <strong>Droit à la portabilité des données (art. 20)&nbsp;:</strong> couvert
          par l&apos;export JSON ci-dessus.
        </li>
        <li>
          <strong>Droit d&apos;introduire une réclamation&nbsp;:</strong> contactez la CNIL
          (France) sur <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener">cnil.fr/fr/plaintes</a>.
        </li>
      </ul>

      <h2>7. Cookies</h2>
      <p>
        Nous utilisons deux cookies strictement nécessaires et aucun cookie de suivi&nbsp;:
      </p>
      <ul>
        <li><code>mfm-session</code> &mdash; HttpOnly, contient votre jeton d&apos;accès pendant que vous êtes connecté.</li>
        <li><code>mfm-refresh</code> &mdash; HttpOnly, sert à émettre un nouveau jeton d&apos;accès avant l&apos;expiration du jeton en cours.</li>
      </ul>
      <p>
        Stripe dépose ses propres cookies sur son propre domaine lorsque vous
        passez au paiement. Cloudflare peut déposer des cookies anti-robots
        (<code>__cf_bm</code>) en périphérie de réseau. Ni les uns ni les autres ne
        sont sous notre contrôle.
      </p>

      <h2>8. Contenus NSFW / illicites</h2>
      <p>
        Générer, téléverser ou partager un contenu illicite dans le pays de
        l&apos;une ou l&apos;autre des parties (notamment les contenus
        pédopornographiques et les autres contenus interdits par le droit
        français) entraîne la fermeture immédiate de votre compte. Nous coopérons
        avec les autorités lorsque la loi l&apos;exige.
      </p>

      <h2>9. Modifications</h2>
      <p>
        Nous mettons cette page à jour lorsque nos pratiques évoluent. La date de
        &laquo;&nbsp;Dernière mise à jour&nbsp;&raquo; en haut de page correspond à
        la version en vigueur. Les modifications substantielles sont annoncées par
        e-mail aux utilisateurs actifs.
      </p>

      <h2>10. Place de marché &amp; Stripe Connect</h2>
      <p>
        Si vous mettez des assets en vente sur notre place de marché, ou si vous
        activez les versements en numéraire en tant que vendeur, les dispositions
        complémentaires suivantes s&apos;appliquent.
      </p>

      <h3>10.1 Données que nous collectons auprès des participants à la place de marché</h3>
      <ul>
        <li>
          Les <strong>métadonnées de l&apos;annonce</strong> (titre, description,
          prix, licence) sont stockées dans notre backend et visibles par tous les
          visiteurs de la place de marché une fois l&apos;annonce approuvée.
        </li>
        <li>
          Le <strong>nom d&apos;auteur affiché</strong> (dérivé de la partie de
          votre adresse e-mail située avant le <code>@</code>) apparaît à côté de
          vos annonces.
        </li>
        <li>
          Les <strong>enregistrements de vente</strong> (identifiant de
          l&apos;acheteur, identifiant du vendeur, montant, devise, identifiant de
          session Stripe, horodatage <code>paid_at</code>, détails du versement)
          sont conservés à des fins comptables et d&apos;audit.
        </li>
      </ul>

      <h3>10.2 Données partagées avec Stripe (vendeurs activant les versements en numéraire)</h3>
      <ul>
        <li>
          Lorsque vous cliquez sur &laquo;&nbsp;Set up cash payouts&nbsp;&raquo;
          (configurer les versements en numéraire), vous êtes redirigé vers{' '}
          <strong>Stripe Connect Express</strong>, où vous fournissez des données
          d&apos;identification (nom, adresse, date de naissance, pièce
          d&apos;identité, IBAN / compte bancaire).
        </li>
        <li>
          Stripe effectue une vérification KYC (&laquo;&nbsp;Know Your
          Customer&nbsp;&raquo;, connaissance du client) au titre des directives
          européennes de lutte contre le blanchiment ou du Bank Secrecy Act
          américain, selon le cas.
        </li>
        <li>
          Nous ne conservons <strong>pas</strong> votre pièce d&apos;identité, votre
          numéro de compte bancaire complet ni votre date de naissance. Stripe est
          le responsable du traitement de ces données.
        </li>
        <li>
          Nous conservons en revanche&nbsp;: l&apos;identifiant de compte Stripe
          (<code>acct_xxx</code>), le pays, les indicateurs
          <code> charges_enabled</code> / <code>payouts_enabled</code>, et la date
          de création du compte.
        </li>
        <li>
          La politique de confidentialité de Stripe s&apos;applique à ces données&nbsp;:{' '}
          <a href="https://stripe.com/privacy" target="_blank" rel="noopener">stripe.com/privacy</a>.
        </li>
      </ul>

      <h3>10.3 Déclarations fiscales</h3>
      <ul>
        <li>
          Lorsque la loi l&apos;exige (seuils 1099-K de l&apos;IRS américain, seuils
          DAC7 de l&apos;Union européenne), nous pouvons transmettre des données de
          vente agrégées aux administrations fiscales via les outils de déclaration
          de Stripe.
        </li>
        <li>
          Les vendeurs sont informés par Stripe si leur activité atteint un seuil
          déclaratif.
        </li>
      </ul>

      <h3>10.4 Vos droits</h3>
      <ul>
        <li>
          Vous pouvez demander à tout moment la suppression de votre compte
          vendeur. Stripe conservera les enregistrements de transaction pendant la
          durée légale minimale (généralement 7&ndash;10 ans à des fins
          comptables).
        </li>
        <li>
          Les annonces actives sont automatiquement dépubliées lorsque le compte
          vendeur est supprimé.
        </li>
        <li>
          Les enregistrements de vente de plus de 30 jours ne sont pas supprimés,
          afin de respecter les obligations comptables.
        </li>
      </ul>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/terms">Conditions générales de vente</a> &middot;{' '}
        <a href="/">Accueil</a>
      </p>
    </main>
  );
}
