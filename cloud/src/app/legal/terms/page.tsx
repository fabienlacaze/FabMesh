// Terms of Service — baseline tailored to MyFabmesh.AI's actual flows.
// The business identity is defined ONCE in @/config/legal-identity.

import { legalIdentity as id } from '@/config/legal-identity';

export const metadata = {
  title: 'Conditions générales de vente — MyFabmesh.AI',
  description: 'Les conditions qui régissent votre utilisation de MyFabmesh.AI.',
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px', lineHeight: 1.65 }}>
      <h1>Conditions générales de vente</h1>
      <p style={{ color: 'var(--text-2)' }}>Dernière mise à jour : 2026-06-20</p>

      <p>
        En créant un compte sur {id.tradeName} (exploité par{' '}
        <strong>{id.operator}</strong>, {id.country}), vous acceptez les présentes
        conditions. Si vous ne les acceptez pas, ne créez pas de compte.
        Contact : <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a>.
      </p>

      <h2>1. Le service</h2>
      <p>
        MyFabmesh.AI vous permet de générer des images et des maillages 3D au
        moyen de modèles d&rsquo;IA exécutés sur des infrastructures GPU de tiers
        (Modal Labs, Replicate). Vous payez avec des crédits prépayés ou un
        abonnement mensuel, tous deux traités par Stripe.
      </p>

      <h2>2. Votre compte</h2>
      <ul>
        <li>Vous devez avoir au moins 16 ans (ou l&rsquo;âge légal du consentement numérique dans votre pays).</li>
        <li>Un seul compte par personne. Pas de partage de compte.</li>
        <li>Il vous appartient de garder votre mot de passe secret. Nous ne vous le demanderons jamais.</li>
        <li>Toute activité suspecte (attaque par force brute, partage d&rsquo;identifiants, aspiration automatisée) justifie une suspension immédiate.</li>
      </ul>

      <h2>3. Crédits et abonnements</h2>
      <ul>
        <li>Les packs de crédits à l&rsquo;unité (Starter / Pro / Studio) n&rsquo;expirent jamais.</li>
        <li>Les abonnements mensuels se renouvellent automatiquement jusqu&rsquo;à leur résiliation par vos soins. Pour résilier, écrivez à{' '}
          <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a> — le renouvellement est
          arrêté sous un jour ouvré et aucun autre prélèvement n&rsquo;est effectué. Les crédits
          d&rsquo;un mois d&rsquo;abonnement ne sont pas reportés sur le mois suivant.</li>
        <li>Remboursements : les crédits prépayés ne sont pas remboursables une fois qu&rsquo;ils ont été dépensés. Les crédits non dépensés sont remboursables dans les 14 jours suivant l&rsquo;achat pour les acheteurs de l&rsquo;UE (droit de rétractation — articles L221-18 et suivants du code de la consommation), sauf si vous avez déjà commencé à les consommer.</li>
        <li>Les tarifs sont affichés sur <a href="/buy">/buy</a> et peuvent évoluer moyennant un préavis de 30 jours. Les achats antérieurs conservent leur valeur en crédits d&rsquo;origine.</li>
        <li>Tous les prix consommateurs sont affichés <strong>toutes taxes comprises (TTC)</strong>. La TVA éventuellement applicable est incluse et calculée en fonction de votre pays de résidence.</li>
      </ul>

      <h2>3a. Droit de rétractation et contenus numériques (consommateurs de l&rsquo;UE)</h2>
      <ul>
        <li>
          <strong>Principe.</strong> En tant que consommateur de l&rsquo;UE, vous disposez
          normalement de 14 jours pour vous rétracter d&rsquo;un achat à distance sans avoir
          à motiver votre décision (articles L221-18 et suivants du code de la
          consommation). Les crédits non dépensés et non utilisés sont remboursables
          pendant ce délai.
        </li>
        <li>
          <strong>Renonciation pour les contenus numériques fournis immédiatement
          (art. L221-28, 13°).</strong> Les crédits sont un contenu numérique
          utilisable immédiatement, et les créations générées sont un contenu
          numérique non fourni sur un support matériel dès que vous lancez une
          génération. En achetant et en cochant la case de consentement au moment
          du paiement, vous{' '}
          <strong>demandez expressément que l&rsquo;exécution commence immédiatement</strong> et
          vous <strong>reconnaissez perdre de ce fait votre droit de rétractation</strong>{' '}
          pour tout crédit dont vous avez commencé la consommation et pour toute
          création déjà générée (art. L221-28, 13°, du code de la consommation).
        </li>
        <li>
          <strong>Ce qui reste remboursable.</strong> Les crédits que vous n&rsquo;avez ni
          dépensés ni commencé à consommer restent remboursables pendant le délai de
          14 jours.
        </li>
        {/* COMMENT EXERCER LE DROIT — l'article L221-18 et suivants impose de
            donner les modalites, pas seulement le principe. La section
            annoncait le droit et sa renonciation sans jamais dire par quel
            canal l'exercer, a partir de quand courent les 14 jours, ni sous
            quel delai le remboursement intervient. */}
        <li>
          <strong>Comment vous rétracter.</strong> Adressez-nous une déclaration
          dénuée d&rsquo;ambiguïté exprimant votre décision — un courriel à{' '}
          <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a> suffit,
          et vous pouvez également écrire à {id.registeredOffice}. Vous pouvez
          utiliser le formulaire type de rétractation ci-dessous, sans y être tenu.
        </li>
        <li>
          <strong>Point de départ des 14 jours.</strong> Pour une fourniture de
          contenu numérique, le délai court à compter du <strong>jour de la
          conclusion du contrat</strong> — c&rsquo;est-à-dire le jour de votre achat — et
          non d&rsquo;une date de livraison (art. L221-18, 1°).
        </li>
        <li>
          <strong>Délai de remboursement.</strong> Au plus tard{' '}
          <strong>14 jours après la réception de votre décision</strong>, en
          utilisant le même moyen de paiement que celui que vous avez employé, sans
          frais pour vous (art. L221-24).
        </li>
      </ul>

      <h3>Formulaire type de rétractation</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
        Ne complétez et ne renvoyez ce formulaire que si vous souhaitez vous
        rétracter du contrat. Recopier ce texte dans un courriel suffit.
      </p>
      <pre style={{
        whiteSpace: 'pre-wrap', padding: '14px 16px', borderRadius: 8,
        border: '1px solid var(--border, #333)', fontSize: 13, lineHeight: 1.6,
      }}>{`À l'attention de ${id.operator} — ${id.registeredOffice} — ${id.supportEmail}

Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation
du contrat de vente portant sur la fourniture du contenu numérique suivant :

  Référence / date de la commande : ......................................
  Nom du (des) consommateur(s) : .........................................
  Adresse du (des) consommateur(s) : .....................................
  Signature du (des) consommateur(s) (uniquement en cas de notification
  du présent formulaire sur papier) : ....................................
  Date : .................................................................

(*) Rayez la mention inutile.`}</pre>

      <h2>4. Usage acceptable</h2>
      <p>Vous vous engagez à NE PAS :</p>
      <ul>
        <li>Générer, téléverser ou partager de contenu illicite — notamment des contenus pédocriminels (CSAM), des contenus portant atteinte aux droits d&rsquo;autrui, ou tout autre contenu interdit par la loi française.</li>
        <li>Tenter de contourner les quotas, les limitations de débit, les filtres NSFW ou tout autre mécanisme de sécurité.</li>
        <li>Sonder l&rsquo;infrastructure à la recherche de vulnérabilités sans notre autorisation écrite (voir <em>Divulgation responsable</em> ci-dessous).</li>
        <li>Revendre l&rsquo;accès à votre compte.</li>
      </ul>

      <h2>5. Propriété intellectuelle</h2>
      <ul>
        <li><strong>Ce que vous téléversez</strong> vous appartient. Vous nous concédez une licence non exclusive et gratuite pour le stocker, l&rsquo;acheminer vers les fournisseurs GPU et le traiter pour votre compte — strictement afin de fournir le service. Nous n&rsquo;entraînons pas de modèles sur vos données d&rsquo;entrée.</li>
        <li><strong>Ce que vous générez</strong> vous appartient, dans les limites de la licence permise par les modèles sous-jacents. Les modèles d&rsquo;IA que nous utilisons autorisent tous, à ce jour, l&rsquo;usage commercial de leurs productions. Vous pouvez exploiter ces productions commercialement. Nous ne revendiquons aucun droit sur elles.</li>
        <li><strong>Contenus générés par IA et transparence.</strong> Toutes les images et créations 3D produites par le service sont générées par une intelligence artificielle. Conformément au règlement européen sur l&rsquo;intelligence artificielle (art. 50), les images générées portent des métadonnées de provenance lisibles par machine (IPTC <code>DigitalSourceType=trainedAlgorithmicMedia</code>). Si vous générez l&rsquo;image d&rsquo;une personne réelle et identifiable, vous êtes seul responsable de la détention des droits nécessaires et des obligations d&rsquo;information applicables à ce type de contenu.</li>
        <li><strong>Notre marque, notre code et notre interface</strong> nous appartiennent. Vous ne pouvez pas les copier.</li>
      </ul>

      <h2>6. Disponibilité du service</h2>
      <p>
        Nous visons une haute disponibilité mais ne promettons pas un
        fonctionnement 24 h/24 et 7 j/7. Des générations peuvent échouer ; dans ce
        cas, nous remboursons automatiquement les crédits. Nous pouvons suspendre
        le service à tout moment pour maintenance, en cas d&rsquo;incident de sécurité,
        ou pour faire appliquer les présentes conditions — voir les coupe-circuits
        d&rsquo;administration décrits dans notre modèle de confidentialité et de
        sécurité.
      </p>

      <h2>7. Résiliation</h2>
      <ul>
        <li>Vous pouvez supprimer votre compte à tout moment depuis <a href="/account">/account</a>. Toutes vos données sont effacées en quelques secondes.</li>
        <li>Nous pouvons suspendre ou résilier les comptes qui enfreignent les présentes conditions ou présentent un risque de sécurité ou juridique. Les crédits inutilisés d&rsquo;un compte résilié sont remboursés, sauf lorsque la résiliation est motivée par une fraude ou un abus.</li>
      </ul>

      <h2>8. Responsabilité</h2>
      <p>
        Dans toute la mesure permise par le droit français : le service est fourni
        &laquo;&nbsp;en l&rsquo;état&nbsp;&raquo;. Nous ne sommes pas responsables des
        dommages indirects (perte de bénéfices, perte de données, pertes
        d&rsquo;opportunités). Notre responsabilité totale sur une période de 12 mois est
        plafonnée au montant total que vous nous avez versé au cours de cette
        période.
      </p>

      <h2>9. Divulgation responsable</h2>
      <p>
        Si vous découvrez une faille de sécurité, merci d&rsquo;écrire à{' '}
        <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a>{' '}
        en détaillant le problème. Nous accusons réception sous 48 heures, nous
        travaillons avec vous à un correctif et nous vous créditons sur une page de
        remerciements publique si vous le souhaitez. N&rsquo;exploitez pas la faille,
        n&rsquo;exfiltrez pas les données d&rsquo;autres utilisateurs, ne publiez rien avant la
        mise en ligne du correctif.
      </p>

      <h2>10. Droit applicable</h2>
      <p>
        Les présentes conditions sont régies par le droit français. Tout litige
        qui ne pourrait être résolu à l&rsquo;amiable relève de la compétence des
        juridictions françaises.
      </p>

      <h2>10a. Médiation de la consommation (Médiateur de la consommation)</h2>
      <p>
        Conformément à l&rsquo;article L612-1 du code de la consommation, après nous
        avoir adressé une réclamation écrite préalable, tout consommateur peut
        saisir gratuitement le médiateur de la consommation désigné :
      </p>
      <ul>
        <li><strong>Médiateur de la consommation désigné :</strong> {id.mediator.name} — {id.mediator.postalAddress} — <a href={id.mediator.url} target="_blank" rel="noopener">{id.mediator.url}</a></li>
      </ul>
      <p>
        Les consommateurs de l&rsquo;UE peuvent également recourir à la plateforme de
        règlement en ligne des litiges de la Commission européenne, à l&rsquo;adresse{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a>.
        Les coordonnées complètes du médiateur figurent également dans les{' '}
        <a href="/legal/mentions">mentions légales</a>.
      </p>

      <h2>11. Place de marché</h2>

      <h3>11.1 Publier des créations</h3>
      <ul>
        <li>Les utilisateurs peuvent publier sur la place de marché les maillages et les images qu&rsquo;ils ont générés sur la plateforme.</li>
        <li>Chaque annonce est examinée par un administrateur avant d&rsquo;être visible par les acheteurs.</li>
        <li>L&rsquo;auteur conserve la propriété de sa création ; la publication confère à la plateforme un droit non exclusif d&rsquo;afficher la création et de traiter les ventes.</li>
        <li>Les auteurs garantissent que leur dépôt ne porte atteinte à aucun droit de tiers.</li>
        <li>Les auteurs peuvent choisir entre cinq licences (usage personnel, CC0, CC-BY 4.0, CC-BY-NC 4.0, libre de droits à usage commercial). La licence est jointe à la création lors du téléchargement.</li>
        <li>Un administrateur peut à tout moment refuser ou retirer une annonce qui enfreint les présentes conditions.</li>
      </ul>

      <h3>11.2 Acheter des créations</h3>
      <ul>
        <li>Les annonces gratuites sont téléchargeables immédiatement par tout utilisateur connecté, une fois validées.</li>
        <li>Les annonces payantes s&rsquo;achètent via Stripe Checkout. Les acheteurs reçoivent une licence non exclusive selon les conditions attachées à la création.</li>
        <li>Les acheteurs ne peuvent PAS redistribuer, revendre ni sous-licencier les créations achetées, sauf si la licence choisie (CC0, CC-BY, commerciale) l&rsquo;autorise expressément.</li>
        <li>Les remboursements sont traités au cas par cas par le support ; contactez-nous dans les 14 jours suivant l&rsquo;achat en indiquant un motif clair.</li>
      </ul>

      <h3>11.3 Commission et reversements</h3>
      <ul>
        <li>La plateforme prélève une commission de 30 % sur chaque vente payante. Le vendeur perçoit 70 % net.</li>
        <li>Les vendeurs peuvent choisir de percevoir leur part soit en crédits de la plateforme (immédiat, avec un bonus de +20 % par rapport à l&rsquo;équivalent en numéraire), soit en numéraire via Stripe Connect (après la vérification d&rsquo;identité KYC prise en charge par Stripe).</li>
        <li>Les versements en numéraire sont effectués par Stripe directement sur le compte bancaire lié du vendeur, selon le calendrier de reversement de Stripe.</li>
        <li>Les vendeurs qui utilisent Stripe Connect acceptent le <a href="https://stripe.com/connect-account/legal">contrat de compte connecté (Connected Account Agreement)</a> de Stripe.</li>
        <li>La plateforme n&rsquo;est pas responsable des retards causés par les vérifications de Stripe, les jours fériés bancaires ou des problèmes de KYC.</li>
      </ul>

      <h3>11.4 Fiscalité</h3>
      <ul>
        <li>Il appartient aux vendeurs de déclarer et d&rsquo;acquitter les impôts et taxes (TVA, impôt sur le revenu) dus dans leur juridiction au titre de leurs revenus tirés de la place de marché.</li>
        <li>La plateforme peut déclarer l&rsquo;activité des vendeurs aux administrations fiscales lorsque la loi l&rsquo;exige (déclaration 1099-K aux États-Unis via Stripe au-delà du seuil de l&rsquo;IRS ; DAC7 dans l&rsquo;UE au-delà du seuil annuel de 2 000 EUR / 30 ventes).</li>
      </ul>

      <h3>11.5 Litiges</h3>
      <ul>
        <li>Les litiges entre acheteur et vendeur (qualité de la création, interprétation de la licence) doivent d&rsquo;abord être portés devant le support de la plateforme.</li>
        <li>La plateforme peut intervenir en médiation et, le cas échéant, rembourser l&rsquo;acheteur ou sanctionner le vendeur.</li>
        <li>Les rétrofacturations (chargebacks) engagées par les acheteurs auprès de leur banque sont traitées par Stripe ; la plateforme peut retenir le montant contesté sur le solde en attente du vendeur jusqu&rsquo;à résolution.</li>
      </ul>

      <h2>12. Droit d&rsquo;auteur et retrait de contenu (DMCA / UE)</h2>
      <p>
        Nous respectons la propriété intellectuelle et donnons suite aux
        notifications valables d&rsquo;atteinte alléguée au titre du DMCA américain
        (17 U.S.C. §512) et de la directive européenne sur le droit d&rsquo;auteur / de
        la LCEN française.
      </p>
      <h3>12.1 Déposer une notification</h3>
      <p>
        Si vous estimez qu&rsquo;un contenu présent sur MyFabmesh.AI (une création
        générée, une annonce de la place de marché ou une image téléversée) porte
        atteinte à votre droit d&rsquo;auteur, écrivez à{' '}
        <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a> avec pour
        objet &laquo;&nbsp;Notification de droit d&rsquo;auteur&nbsp;&raquo; en indiquant :
        l&rsquo;identification de l&rsquo;œuvre protégée et du contenu litigieux (avec une URL
        ou un identifiant d&rsquo;annonce) ; vos coordonnées ; une déclaration selon
        laquelle vous avez la conviction de bonne foi que cet usage n&rsquo;est pas
        autorisé ; une déclaration, sous peine de sanctions pour parjure, selon
        laquelle les informations sont exactes et que vous êtes le titulaire des
        droits ou habilité à agir pour son compte ; ainsi que votre signature
        manuscrite ou électronique. Nous retirerons ou rendrons inaccessible le
        contenu signalé dans les meilleurs délais et en informerons l&rsquo;utilisateur
        qui l&rsquo;a mis en ligne.
      </p>
      <h3>12.2 Contre-notification</h3>
      <p>
        Si votre contenu a été retiré et que vous estimez qu&rsquo;il s&rsquo;agit d&rsquo;une erreur
        ou d&rsquo;une identification erronée, adressez une contre-notification à la même
        adresse, comportant l&rsquo;identification du contenu retiré, vos coordonnées,
        une déclaration sous peine de sanctions pour parjure selon laquelle le
        retrait résulte d&rsquo;une erreur, et votre signature. Nous pourrons rétablir le
        contenu, sauf si l&rsquo;auteur de la notification initiale engage une action en
        justice.
      </p>
      <h3>12.3 Atteintes répétées</h3>
      <p>
        Les comptes qui portent atteinte de manière répétée aux droits de tiers
        sont suspendus ou résiliés.
      </p>

      <h2>13. Signaler un contenu illicite (règlement européen sur les services numériques, DSA)</h2>
      <p>
        En vertu du règlement européen sur les services numériques
        (règlement 2022/2065), toute personne peut nous signaler un contenu
        qu&rsquo;elle considère comme illicite.
      </p>
      <ul>
        <li>
          <strong>Comment signaler :</strong> utilisez la commande
          &laquo;&nbsp;Signaler&nbsp;&raquo; sur une annonce de la place de marché,
          ou écrivez à{' '}
          <a href={`mailto:${id.supportEmail}`}>{id.supportEmail}</a> avec pour
          objet &laquo;&nbsp;Contenu illicite&nbsp;&raquo;, une explication des
          raisons pour lesquelles le contenu est illicite, et sa localisation (URL
          ou identifiant d&rsquo;annonce).
        </li>
        <li>
          <strong>Point de contact :</strong> l&rsquo;adresse ci-dessus est notre point
          de contact unique pour les utilisateurs et les autorités (art. 11 et 12
          du DSA).
        </li>
        <li>
          <strong>Notre action :</strong> nous examinons chaque signalement, nous
          retirons ou rendons inaccessible le contenu illicite ou contraire aux
          présentes conditions, et nous informons l&rsquo;utilisateur concerné par un{' '}
          <em>exposé des motifs</em> (art. 17 du DSA).
        </li>
        <li>
          <strong>Recours :</strong> si votre contenu ou votre compte fait l&rsquo;objet
          d&rsquo;une restriction, vous pouvez contester la décision en répondant à
          l&rsquo;exposé des motifs ; un humain réexamine le dossier.
        </li>
        <li>
          <strong>Les contenus illicites ne sont jamais autorisés</strong> — en
          particulier les contenus pédocriminels (CSAM), les contenus terroristes
          et les contenus portant atteinte aux droits d&rsquo;autrui. Nous coopérons avec
          les autorités compétentes et signalons les infractions lorsque la loi
          l&rsquo;exige.
        </li>
      </ul>
      <h3>13.1 Agents désignés</h3>
      <ul style={{ fontSize: 14 }}>
        <li><strong>Point de contact unique DSA et agent désigné droit d&rsquo;auteur / DMCA :</strong> {id.designatedAgent}, joignable à <a href={`mailto:${id.contactEmail}`}>{id.contactEmail}</a>. Avant toute distribution auprès d&rsquo;utilisateurs américains, cet agent doit également être enregistré auprès du DMCA Designated Agent Directory du U.S. Copyright Office.</li>
        <li><strong>Identité de l&rsquo;entreprise immatriculée</strong> (exploitant, SIRET, siège social, hébergeur) : voir les <a href="/legal/mentions">mentions légales</a>.</li>
      </ul>

      <p style={{ marginTop: 32, fontSize: 13 }}>
        <a href="/legal/privacy">Politique de confidentialité</a> &middot;{' '}
        <a href="/legal/licenses">Licences tierces</a> &middot;{' '}
        <a href="/">Accueil</a>
      </p>
    </main>
  );
}
