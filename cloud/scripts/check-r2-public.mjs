/**
 * GARDE-FOU DE DEPLOIEMENT — l'accès public du bucket R2 doit rester COUPÉ.
 *
 * Pourquoi ce script existe. Le 2026-08-18, un audit a découvert que le bucket
 * `myfabmesh-meshes` était exposé via son URL `r2.dev`. Étaient téléchargeables
 * par n'importe qui, sans aucun jeton :
 *
 *     _meta/admin-totp.json      le secret 2FA de l'administrateur, en clair
 *     _meta/admin_password.json  sel + hash + identifiant de l'administrateur
 *     _meta/admin_audit/*.log    le journal d'audit, avec l'adresse IP du gérant
 *     <uid>/...                  les meshes des clients, dont un asset vendu
 *
 * AUCUN CODE NE PEUT EMPÊCHER CELA : l'URL `r2.dev` sert les objets
 * directement depuis Cloudflare, sans jamais passer par le worker. Ni une
 * vérification d'authentification, ni une règle de routage n'y changent quoi
 * que ce soit. La seule protection est de ne jamais activer cet accès public.
 *
 * D'où ce contrôle avant déploiement : si quelqu'un le réactive un jour — par
 * curiosité, pour déboguer un téléchargement, ou en suivant un tutoriel — le
 * déploiement échoue et dit pourquoi.
 *
 * Le mécanisme légitime existe déjà et fonctionne : `signedR2Url()`
 * (worker.ts) sert les objets depuis l'origine du worker avec une signature
 * HMAC et une expiration, à partir du secret `R2_URL_SIGNING_SECRET`. Rien ne
 * justifie de rouvrir l'accès public.
 *
 * Contournement volontaire, en connaissance de cause : FABMESH_ALLOW_R2_PUBLIC=1
 */
import { execSync } from 'node:child_process';

const BUCKET = 'myfabmesh-meshes';

if (process.env.FABMESH_ALLOW_R2_PUBLIC === '1') {
  console.warn('[check-r2-public] contrôle DÉSACTIVÉ par FABMESH_ALLOW_R2_PUBLIC=1 — à vos risques.');
  process.exit(0);
}

let sortie = '';
try {
  // `execSync` et non `execFileSync` : sous Windows, lancer npx.cmd sans shell
  // echoue en EINVAL, et le garde-fou repondait alors « controle impossible »
  // a chaque fois — donc ne protegeait rien.
  sortie = execSync(
    `npx wrangler r2 bucket dev-url get ${BUCKET}`,
    { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (e) {
  // Pas d'authentification, pas de réseau, API en panne : on NE BLOQUE PAS le
  // déploiement pour autant. Ce garde-fou protège d'une erreur de configuration,
  // il ne doit pas devenir un point de panne qui empêche de livrer un correctif.
  const msg = (e && (e.stderr || e.message) || '').toString().trim().split('\n')[0];
  console.warn(`[check-r2-public] contrôle impossible (${msg || 'erreur inconnue'}) — on continue.`);
  process.exit(0);
}

const texte = String(sortie);
const estPublic = /Public access is enabled/i.test(texte);

if (estPublic) {
  const url = (texte.match(/https:\/\/[^\s'"]+r2\.dev/i) || [''])[0];
  console.error('');
  console.error('  DEPLOIEMENT REFUSE — le bucket R2 est PUBLIC.');
  console.error('');
  console.error(`  ${url || "l'URL r2.dev"} sert les objets du bucket`);
  console.error(`  « ${BUCKET} » a n'importe qui, sans authentification, en`);
  console.error('  court-circuitant entierement le worker.');
  console.error('');
  console.error('  Cela expose notamment :');
  console.error('    _meta/admin-totp.json      le secret 2FA administrateur');
  console.error('    _meta/admin_password.json  sel + hash + identifiant admin');
  console.error('    _meta/admin_audit/*.log    le journal d audit et son IP');
  console.error('    <uid>/...                  les fichiers des clients');
  console.error('');
  console.error('  Pour corriger :');
  console.error(`    npx wrangler r2 bucket dev-url disable ${BUCKET}`);
  console.error('');
  console.error('  Les telechargements continueront de fonctionner : signedR2Url()');
  console.error('  sert deja les objets depuis le worker avec une signature HMAC');
  console.error('  et une expiration (secret R2_URL_SIGNING_SECRET, deja deploye).');
  console.error('');
  process.exit(1);
}

console.log(`[check-r2-public] OK — l'acces public de « ${BUCKET} » est coupe.`);
