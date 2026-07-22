// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the operator's registered legal identity.
//
// Fill every field marked [À_COMPLÉTER: …] ONCE, here, before the commercial
// launch. Every legal / commercial page (Mentions légales, Terms of Service,
// Privacy Policy, checkout receipts) imports from this file, so editing a value
// here propagates it everywhere automatically — do NOT hard-code identity data
// in the page components anymore.
//
// A value is "ready" when it no longer contains the TODO marker. You can assert
// this in a pre-launch check with `legalIdentityUnfilledFields()` below.
// ─────────────────────────────────────────────────────────────────────────────

/** Marker wrapper so all unfilled fields are greppable and detectable. */
const TODO = (hint: string): string => `[À_COMPLÉTER: ${hint}]`;

export interface Mediator {
  /** Name of the approved consumer mediator (médiateur agréé), e.g. CM2C / Medicys. */
  name: string;
  /** Full postal address of the mediator. */
  postalAddress: string;
  /** Online referral (saisine) URL of the mediator. */
  url: string;
}

export interface LegalHost {
  name: string;
  address: string;
  url: string;
}

export interface LegalIdentity {
  /** Public trade / brand name. */
  tradeName: string;
  /** Operating entity name (person or company). */
  operator: string;
  /** Legal form — e.g. entrepreneur individuel / micro-entreprise / EURL / SASU. */
  legalForm: string;
  /** SIREN (9 digits) or SIRET (14 digits). */
  siret: string;
  /** RCS or RM registration number + city of registration. */
  rcs: string;
  /** Share capital (companies only; "sans objet" otherwise). */
  shareCapital: string;
  /** Full postal address of the registered office (siège social). */
  registeredOffice: string;
  /** Intra-community VAT number — or the Art. 293 B CGI franchise mention. */
  vatNumber: string;
  /** Director of publication (Directeur de la publication). */
  publicationDirector: string;
  /** Professional / branded contact mailbox. */
  contactEmail: string;
  /** Current operational support & legal-notice mailbox. */
  supportEmail: string;
  /** Country of establishment. */
  country: string;
  /** DSA single point of contact + copyright / DMCA designated agent name. */
  designatedAgent: string;
  /** Approved consumer mediator (Art. L612-1 Code de la consommation). */
  mediator: Mediator;
  /** Hosting provider (LCEN art. 6-III). */
  host: LegalHost;
}

export const legalIdentity: LegalIdentity = {
  tradeName: 'MyFabmesh.AI',
  operator: 'Ayros Studio',
  legalForm: TODO('forme juridique — ex. entrepreneur individuel / micro-entreprise / EURL / SASU'),
  siret: TODO('SIREN 9 chiffres / SIRET 14 chiffres'),
  rcs: TODO("n° RCS ou RM + ville d'immatriculation"),
  shareCapital: TODO('capital social — uniquement si société ; sinon « sans objet »'),
  registeredOffice: TODO('adresse postale complète du siège social'),
  vatNumber: TODO('n° TVA intracommunautaire — ou « TVA non applicable, art. 293 B du CGI » si franchise en base'),
  publicationDirector: TODO('nom du directeur de la publication — ex. Fabien Lacaze'),
  // Dedicated business mailbox (NOT the owner's personal address). Same inbox is
  // used as the Brevo email sender so recipients see a business address.
  contactEmail: 'myfabmesh.contact@gmail.com',
  supportEmail: 'myfabmesh.contact@gmail.com',
  country: 'France',
  designatedAgent: TODO("nom de l'agent désigné DSA/DMCA — doit aussi être enregistré au U.S. Copyright Office avant distribution aux USA"),
  mediator: {
    name: TODO('médiateur agréé — ex. CM2C / Medicys — nom'),
    postalAddress: TODO('adresse postale complète du médiateur'),
    url: TODO('URL de saisine en ligne du médiateur'),
  },
  host: {
    name: 'Cloudflare, Inc.',
    address: '101 Townsend Street, San Francisco, CA 94107, USA',
    url: 'https://www.cloudflare.com',
  },
};

/** True while the value still carries the unfilled placeholder marker. */
export function isUnfilled(value: string): boolean {
  return value.startsWith('[À_COMPLÉTER:');
}

/**
 * Returns the dotted paths of every identity field still left as a placeholder.
 * Use in a pre-launch guard to fail the build if the operator forgot one.
 */
export function legalIdentityUnfilledFields(id: LegalIdentity = legalIdentity): string[] {
  const missing: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof val === 'string') {
        if (isUnfilled(val)) missing.push(path);
      } else if (val && typeof val === 'object') {
        walk(val as Record<string, unknown>, path);
      }
    }
  };
  walk(id as unknown as Record<string, unknown>, '');
  return missing;
}
