/**
 * Garde de pre-lancement : refuse de construire si une mention legale
 * obligatoire est restee a l'etat de gabarit.
 *
 * POURQUOI CE FICHIER EXISTE
 * `cloud/src/config/legal-identity.ts` expose depuis longtemps
 * `legalIdentityUnfilledFields()`, avec ce commentaire : « Use in a
 * pre-launch guard to fail the build if the operator forgot one ».
 * **Ce garde n'avait jamais ete branche.** Consequence constatee le
 * 2026-08-08 : la page /legal/mentions repondait 200 en PRODUCTION et
 * affichait 22 marqueurs « [À_COMPLÉTER: SIREN 9 chiffres…] » a tout
 * visiteur. Quatre agents d'audit independants l'ont signale.
 *
 * Le SIREN, le RCS, l'adresse du siege, le directeur de la publication et le
 * mediateur agree sont OBLIGATOIRES pour une vente en ligne en France
 * (LCEN art. 6-III, Code de la consommation art. L612-1). Ce ne sont pas des
 * details cosmetiques : leur absence expose l'exploitant.
 *
 * Ces valeurs n'appartiennent qu'a l'exploitant — aucun outil ne peut les
 * inventer. Ce que l'outillage PEUT faire, c'est rendre impossible de
 * publier sans elles.
 *
 * ECHAPPATOIRE ASSUMEE : `ALLOW_UNFILLED_LEGAL=1` laisse passer, pour ne pas
 * bloquer un deploiement d'urgence sans rapport (correctif de securite, par
 * exemple). L'avertissement reste bien visible dans la sortie.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ici = dirname(fileURLToPath(import.meta.url));
const source = join(ici, '..', 'src', 'config', 'legal-identity.ts');

// On lit le TypeScript en texte plutot que de le compiler : ce script tourne
// AVANT `next build`, donc avant toute transpilation. Le marqueur est stable
// et defini au meme endroit (`isUnfilled`), il n'y a rien a deviner.
const texte = readFileSync(source, 'utf8');

// Ne regarder que l'objet `legalIdentity`, pas les commentaires ni les
// exemples de la doc en tete de fichier.
const debut = texte.indexOf('export const legalIdentity');
const fin = texte.indexOf('\n};', debut);
if (debut < 0 || fin < 0) {
  console.error('[legal] impossible de localiser `legalIdentity` dans ' + source);
  process.exit(1);
}
const bloc = texte.slice(debut, fin);

const manquants = [];
for (const ligne of bloc.split('\n')) {
  const m = ligne.match(/^\s*([A-Za-z]+)\s*:\s*TODO\(/);
  if (m) manquants.push(m[1]);
}

// ── Second balayage : les marqueurs ecrits DIRECTEMENT dans les pages ────────
// POURQUOI : le garde ci-dessus ne lisait que `legal-identity.ts`. Or le
// 2026-08-23, la section « 4.1 Transferts hors de l'Union europeenne » de
// /legal/privacy a introduit des « [À_COMPLÉTER: …] » dans le JSX lui-meme —
// deliberement, parce qu'aucun outil ne peut deviner quelle garantie du
// chapitre V du RGPD a reellement ete signee avec chaque prestataire.
// Ces marqueurs-la n'etaient surveilles par RIEN : une fois l'identite du
// config remplie, la construction serait repassee au vert et la politique de
// confidentialite aurait ete PUBLIEE avec ses trous, exactement le scenario
// (marqueurs visibles en production) que ce fichier existe pour empecher.
const dossierLegal = join(ici, '..', 'src', 'app', 'legal');

/** Chemins de tous les .tsx sous src/app/legal, recursivement. */
function pagesLegales(dossier) {
  const trouves = [];
  let entrees;
  try { entrees = readdirSync(dossier); } catch { return trouves; }
  for (const nom of entrees) {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) trouves.push(...pagesLegales(chemin));
    else if (nom.endsWith('.tsx')) trouves.push(chemin);
  }
  return trouves;
}

// On cherche le marqueur seul : dans le JSX il s'ecrit « [À_COMPLÉTER&nbsp;: »
// (espace insecable avant le deux-points, convention typographique francaise
// du fichier) alors que le config ecrit « [À_COMPLÉTER: ». Le prefixe commun
// est le seul repere fiable.
const marqueursPages = [];
for (const chemin of pagesLegales(dossierLegal)) {
  const lignes = readFileSync(chemin, 'utf8').split('\n');
  lignes.forEach((ligne, i) => {
    if (ligne.includes('[À_COMPLÉTER')) {
      marqueursPages.push(`${relative(join(ici, '..'), chemin).replace(/\\/g, '/')}:${i + 1}`);
    }
  });
}

if (manquants.length === 0 && marqueursPages.length === 0) {
  console.log('[legal] identite legale complete — 0 champ manquant, 0 marqueur en page');
  process.exit(0);
}

const dur = process.env.ALLOW_UNFILLED_LEGAL !== '1';
const entete = dur ? 'CONSTRUCTION REFUSEE' : 'AVERTISSEMENT (contournement actif)';
const total = manquants.length + marqueursPages.length;

console.error('');
console.error('========================================================================');
console.error(`[legal] ${entete} — ${total} mention(s) legale(s) non remplie(s)`);
console.error('========================================================================');

if (manquants.length > 0) {
  console.error(`  Identite (cloud/src/config/legal-identity.ts) — ${manquants.length} champ(s) :`);
  for (const champ of manquants) console.error('   - ' + champ);
  console.error('');
  console.error('  Ces champs s\'affichent LITTERALEMENT sur /legal/mentions, visibles');
  console.error('  par tout visiteur, sous la forme « [À_COMPLÉTER: … ] ».');
  console.error('');
  console.error('  Ils sont obligatoires pour vendre en ligne en France :');
  console.error('    LCEN art. 6-III .............. identite, siege, directeur de publication');
  console.error('    Code conso. art. L612-1 ...... mediateur de la consommation agree');
  console.error('');
}

if (marqueursPages.length > 0) {
  console.error(`  Marqueurs ecrits dans les pages — ${marqueursPages.length} occurrence(s) :`);
  for (const endroit of marqueursPages) console.error('   - ' + endroit);
  console.error('');
  console.error('  Ce texte s\'affiche tel quel au visiteur. Il signale une information');
  console.error('  que seul l\'exploitant peut fournir — typiquement la garantie du');
  console.error('  chapitre V du RGPD (art. 45 adequation / art. 46.2.c clauses types)');
  console.error('  invoquee pour chaque prestataire etabli hors de l\'Union europeenne.');
  console.error('  Remplacer le marqueur par la mention REELLE ; ne jamais le supprimer');
  console.error('  en ecrivant une garantie non verifiee.');
  console.error('');
}

console.error('  Contournement d\'urgence : ALLOW_UNFILLED_LEGAL=1 npm run build');
console.error('========================================================================');
console.error('');

process.exit(dur ? 1 : 0);
