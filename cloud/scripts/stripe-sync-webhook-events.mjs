#!/usr/bin/env node
/**
 * Aligne les evenements auxquels le point de terminaison Stripe est ABONNE
 * sur ceux que le worker sait effectivement traiter.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Constat du 2026-08-23, par mesure sur le compte : le point de terminaison
 * n'etait abonne qu'a TROIS evenements. Ni `charge.refunded`, ni
 * `charge.dispute.*`, ni `invoice.paid`.
 *
 * Consequence : tout le gestionnaire de remboursement et de litige — corrige
 * quatre fois de suite, dont trois fois pour rien — est INATTEIGNABLE. Il
 * compile, il est deploye, et Stripe ne l'appelle jamais. Un client rembourse
 * garde ses credits ; un litige perdu ne reprend rien ; et un abonnement paye
 * n'est jamais credite, faute de `invoice.paid`.
 *
 * C'est le cas d'ecole du correctif inerte : la panne n'etait pas dans le
 * code mais dans ce qui devait l'appeler. Un `curl` sur le code n'aurait
 * jamais pu le montrer.
 *
 * POURQUOI PAS A LA MAIN
 * ----------------------
 * La liste doit rester le miroir exact des `event.type === '...'` de
 * `src/worker.ts`. Cochee a la main dans le tableau de bord, elle derive au
 * premier evenement ajoute au code — c'est exactement ce qui s'est passe :
 * `checkout.session.async_payment_succeeded` figurait dans l'abonnement mais
 * n'existait qu'en COMMENTAIRE dans le worker, et les evenements de
 * remboursement etaient dans le worker sans etre dans l'abonnement. Les deux
 * listes avaient diverge dans les deux sens a la fois.
 *
 * Le script est idempotent : il compare, et ne met a jour que s'il manque
 * quelque chose. Il n'enleve jamais un evenement que tu aurais ajoute
 * volontairement — il le signale seulement.
 *
 * USAGE
 *   node scripts/stripe-sync-webhook-events.mjs                 # simulation
 *   node scripts/stripe-sync-webhook-events.mjs --apply         # applique
 *   STRIPE_SECRET_KEY=sk_live_... node ... --apply --live       # mode reel
 *
 * La cle est lue dans STRIPE_SECRET_KEY, sinon dans cloud/.env.local.
 * Une cle `sk_live_` exige `--live` en plus de `--apply`.
 *
 * ATTENTION AU MODE. Les points de terminaison sont SEPARES entre test et
 * live : les aligner en test ne fait rien pour la production. Il faut passer
 * le script avec la cle live une fois la vente ouverte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, '..');

/* Doit rester le miroir des `event.type === '...'` de src/worker.ts.
 * Verifiable d'une commande :
 *   grep -oE "event\.type === '[a-z_.]+'" src/worker.ts | sort -u          */
const ATTENDUS = [
  'account.updated',
  'charge.dispute.closed',
  'charge.dispute.created',
  'charge.refunded',
  'checkout.session.async_payment_succeeded',
  'checkout.session.completed',
  'invoice.paid',
];

const args = new Set(process.argv.slice(2));
const APPLIQUER = args.has('--apply');
const LIVE_OK = args.has('--live');

function cle() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  const f = path.join(RACINE, '.env.local');
  if (!fs.existsSync(f)) return null;
  for (const l of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = l.match(/^STRIPE_SECRET_KEY=(.*)$/);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  return null;
}

const SK = cle();
if (!SK) {
  console.error('STRIPE_SECRET_KEY introuvable (ni dans l\'environnement, ni dans cloud/.env.local).');
  process.exit(1);
}
const EST_LIVE = SK.startsWith('sk_live_');
const MODE = EST_LIVE ? 'LIVE (argent reel)' : 'TEST';

if (EST_LIVE && APPLIQUER && !LIVE_OK) {
  console.error('Cle LIVE detectee. Ajoute --live pour confirmer. Rien n\'a ete fait.');
  process.exit(2);
}

async function stripe(chemin, corps, methode) {
  const opts = {
    method: methode || (corps ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${SK}` },
  };
  if (corps) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(corps).toString();
  }
  const r = await fetch(`https://api.stripe.com/v1/${chemin}`, opts);
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || JSON.stringify(j).slice(0, 200);
    throw new Error(`Stripe ${chemin} -> ${r.status} : ${msg}`);
  }
  return j;
}

console.log(`Mode : ${MODE}${APPLIQUER ? '' : '  (simulation — rien ne sera modifie)'}`);
console.log();

const liste = await stripe('webhook_endpoints?limit=100');
const points = (liste.data || []).filter((p) => p.status !== 'disabled');

if (!points.length) {
  console.error('AUCUN point de terminaison actif sur ce compte.');
  console.error('Le worker ne recevra donc RIEN : ni credit, ni remboursement.');
  console.error('Cree-le dans le tableau de bord Stripe vers');
  console.error('  https://<ton-worker>/api/stripe/webhook');
  console.error('puis relance ce script.');
  process.exit(1);
}

let aFaire = 0;
for (const p of points) {
  const actuels = new Set(p.enabled_events || []);
  const tout = actuels.has('*');
  const manquants = tout ? [] : ATTENDUS.filter((e) => !actuels.has(e));
  const enTrop = [...actuels].filter((e) => e !== '*' && !ATTENDUS.includes(e));

  console.log(`${p.id}  ${p.url}`);
  console.log(`  abonne a ${tout ? 'TOUS les evenements (*)' : `${actuels.size} evenement(s)`}`);

  if (enTrop.length) {
    console.log(`  en trop (conserves, jamais retires par ce script) : ${enTrop.join(', ')}`);
  }
  if (!manquants.length) {
    console.log('  -> rien a faire : tous les evenements traites sont abonnes.');
    console.log();
    continue;
  }

  aFaire++;
  console.log(`  MANQUANTS (${manquants.length}) : ${manquants.join(', ')}`);
  for (const m of manquants) {
    if (m === 'charge.refunded' || m.startsWith('charge.dispute')) {
      console.log(`     ${m} absent -> un client rembourse GARDE ses credits.`);
    } else if (m === 'invoice.paid') {
      console.log('     invoice.paid absent -> un abonnement paye n\'est JAMAIS credite.');
    } else if (m === 'checkout.session.async_payment_succeeded') {
      console.log('     async_payment_succeeded absent -> un paiement SEPA/differe');
      console.log('     est encaisse sans que rien ne soit livre.');
    }
  }

  if (!APPLIQUER) {
    console.log('  (simulation — relance avec --apply pour aligner)');
    console.log();
    continue;
  }

  // On REUNIT l'existant et l'attendu : jamais de retrait implicite.
  const fusion = [...new Set([...actuels, ...ATTENDUS])].filter((e) => e !== '*');
  const corps = {};
  fusion.forEach((e, i) => { corps[`enabled_events[${i}]`] = e; });
  await stripe(`webhook_endpoints/${p.id}`, corps);
  console.log(`  -> aligne : ${fusion.length} evenement(s) abonnes.`);
  console.log();
}

if (!aFaire) {
  console.log('Tout est deja aligne.');
} else if (!APPLIQUER) {
  console.log(`${aFaire} point(s) de terminaison a aligner. Relance avec --apply.`);
  process.exit(3);
} else {
  console.log('Alignement termine.');
  if (!EST_LIVE) {
    console.log();
    console.log('RAPPEL : c\'etait le compte de TEST. Les points de terminaison live');
    console.log('sont separes — repasse ce script avec la cle sk_live_ avant la vente,');
    console.log('sinon les remboursements resteront inatteignables en production.');
  }
}
