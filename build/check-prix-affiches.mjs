/**
 * GARDE-FOU — les prix AFFICHÉS doivent suivre la grille du worker.
 *
 * Pourquoi ce contrôle existe. Audit du 2026-08-18 : chaque prix montré à
 * l'utilisateur était une constante, et TOUTES avaient dérivé SOUS le prix
 * réellement débité. Toujours dans le même sens — annoncer moins que ce
 * qu'on prélève.
 *
 *     maillage « fast »   annoncé 1   facturé 8    ×8
 *     maillage balanced   annoncé 2   facturé 10
 *     image               annoncé 2   facturé 3
 *     Auto Inpaint        annoncé 3   facturé 6
 *     variantes           annoncé N   facturé 3×N
 *
 * Aucune de ces divergences n'a été détectée par un test : elles ont toutes
 * été trouvées à l'œil, par hasard. C'est cela que ce script corrige.
 *
 * Il vérifie deux choses :
 *   1. Les valeurs de repli de l'interface web (_COST_DEFAULTS) valent bien
 *      ce que facture le worker (PRICING_DEFAULTS), via la table de
 *      correspondance _COST_PRICING_KEY.
 *   2. Les anciennes constantes en dur du desktop ne sont pas revenues, et
 *      les pastilles lisent toujours la grille.
 *
 * Usage : node build/check-prix-affiches.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');

const erreurs = [];
const ok = [];

/* ── 1. La grille du worker, source de vérité ─────────────────────────── */
const worker = lire('cloud/src/worker.ts');
const blocGrille = worker.match(/const PRICING_DEFAULTS = \{([\s\S]*?)\n\};/);
if (!blocGrille) {
  console.error('  PRICING_DEFAULTS introuvable dans cloud/src/worker.ts — le contrôle ne peut pas s\'exécuter.');
  process.exit(1);
}
const grille = {};
for (const m of blocGrille[1].matchAll(/^\s*([a-z_0-9]+)\s*:\s*(\d+)\s*,/gim)) {
  grille[m[1]] = Number(m[2]);
}
ok.push(`grille du worker lue : ${Object.keys(grille).length} tarifs`);

/* ── 2. Les valeurs de repli du web doivent correspondre ──────────────── */
const web = lire('cloud/public/app/cloud-overrides.js');
const blocDefauts = web.match(/const _COST_DEFAULTS = \{([\s\S]*?)\};/);
const blocCles = web.match(/const _COST_PRICING_KEY = \{([\s\S]*?)\};/);

if (!blocDefauts || !blocCles) {
  erreurs.push('_COST_DEFAULTS ou _COST_PRICING_KEY introuvable dans cloud-overrides.js — '
    + 'si ces tables ont été renommées, mettre ce contrôle à jour plutôt que de le supprimer.');
} else {
  const defauts = {};
  for (const m of blocDefauts[1].matchAll(/([a-z_0-9]+)\s*:\s*(\d+)/gi)) defauts[m[1]] = Number(m[2]);
  const cles = {};
  for (const m of blocCles[1].matchAll(/([a-z_0-9]+)\s*:\s*'([a-z_0-9]+)'/gi)) cles[m[1]] = m[2];

  for (const [nom, valeur] of Object.entries(defauts)) {
    const cle = cles[nom];
    if (!cle) {
      erreurs.push(`_COST_DEFAULTS.${nom} n'a pas de correspondance dans _COST_PRICING_KEY : `
        + 'ce badge ne pourra jamais être resynchronisé sur la grille.');
      continue;
    }
    const reel = grille[cle];
    if (typeof reel !== 'number') {
      erreurs.push(`_COST_PRICING_KEY.${nom} pointe sur « ${cle} », qui n'existe pas dans PRICING_DEFAULTS.`);
      continue;
    }
    if (valeur !== reel) {
      erreurs.push(`_COST_DEFAULTS.${nom} = ${valeur} alors que le worker facture ${reel} (clé ${cle}). `
        + (valeur < reel ? 'ANNONCE MOINS QUE FACTURE — pratique commerciale trompeuse.' : 'Sur-annoncé.'));
    }
  }
  if (!erreurs.length) ok.push(`${Object.keys(defauts).length} valeurs de repli web conformes à la grille`);
}

/* ── 3. Le desktop ne doit pas réintroduire de prix en dur ────────────── */
const rendu = lire('src/renderer/index2.js');

const interdits = [
  { motif: /const BASE = \{\s*fast:\s*\d+/, quoi: 'la table de prix des presets de maillage en dur (const BASE = { fast: … })' },
  { motif: /textContent = String\(\s*\d+\s*\*\s*count\s*\)/, quoi: 'un multiplicateur de prix d\'image en dur (String(N * count))' },
];
for (const { motif, quoi } of interdits) {
  if (motif.test(rendu)) {
    erreurs.push(`src/renderer/index2.js réintroduit ${quoi}. Les prix doivent venir de window._prixDe().`);
  }
}

const requis = [
  { motif: /window\._prixDe\s*=/, quoi: 'la fonction de lecture de grille window._prixDe' },
  { motif: /_prixDe\('text2image'\)/, quoi: 'la pastille image lisant text2image dans la grille' },
  { motif: /CLE_PRESET/, quoi: 'la correspondance preset → clé de grille pour le maillage' },
];
for (const { motif, quoi } of requis) {
  if (!motif.test(rendu)) {
    erreurs.push(`src/renderer/index2.js ne contient plus ${quoi} — les prix affichés risquent de ne plus suivre la grille.`);
  }
}
if (!interdits.some(({ motif }) => motif.test(rendu))) ok.push('desktop : aucun prix en dur détecté');

/* ── Verdict ──────────────────────────────────────────────────────────── */
if (erreurs.length) {
  console.error('');
  console.error('  PRIX AFFICHÉS INCOHÉRENTS AVEC LA FACTURATION');
  console.error('');
  for (const e of erreurs) console.error('   - ' + e);
  console.error('');
  console.error('  Annoncer un prix inférieur à celui débité est une pratique');
  console.error('  commerciale trompeuse. La grille du worker fait foi :');
  console.error('  cloud/src/worker.ts, PRICING_DEFAULTS.');
  console.error('');
  process.exit(1);
}

for (const l of ok) console.log('[check-prix] ' + l);
console.log('[check-prix] OK — les prix affichés suivent la facturation.');
