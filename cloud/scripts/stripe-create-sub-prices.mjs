#!/usr/bin/env node
/**
 * Cree (ou retrouve) les Prix Stripe des trois abonnements, et imprime les
 * commandes `wrangler secret put` a executer.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Constat du 2026-08-20 : GET /api/pricing/availability rend
 *   {"sub_starter":false,"sub_pro":false,"sub_studio":false}
 * Les trois cartes d'abonnement sont donc MASQUEES sur /buy, parce que
 * `handlePricingAvailability` exige un secret `STRIPE_PRICE_<PACKID>` pour
 * les packs en mode subscription — et ces trois secrets n'ont jamais ete
 * poses. Le revenu recurrent n'etait pas mal tarife : il n'etait pas branche.
 *
 * Les packs a l'unite, eux, n'ont besoin d'aucun Prix preconfigure (le
 * worker les cree a la volee avec `price_data`), ce qui explique que
 * personne ne s'en soit apercu.
 *
 * POURQUOI PAS A LA MAIN
 * ----------------------
 * Les montants et les credits vivent dans `PACKS` (worker.ts). Creer les
 * Prix a la main dans le tableau de bord Stripe, c'est accepter qu'ils
 * derivent silencieusement du code un jour ou l'autre. Ce script lit les
 * memes valeurs et pose un `lookup_key` stable, donc il est idempotent :
 * relance-le autant de fois que tu veux, il retrouve les Prix existants au
 * lieu d'en empiler des doublons.
 *
 * UN PRIX STRIPE EST IMMUABLE. Changer un montant = creer un NOUVEAU Prix
 * (les abonnes existants gardent l'ancien). Le script le dit au lieu de le
 * cacher : si le montant en base ne correspond plus a PACKS, il refuse et
 * explique.
 *
 * USAGE
 *   node scripts/stripe-create-sub-prices.mjs                # simulation
 *   node scripts/stripe-create-sub-prices.mjs --apply        # cree vraiment
 *   STRIPE_SECRET_KEY=sk_live_... node ... --apply --live    # mode reel
 *
 * La cle est lue dans STRIPE_SECRET_KEY, sinon dans cloud/.env.local.
 * Une cle `sk_live_` exige `--live` en plus de `--apply` : on ne touche pas
 * a de l'argent reel par inadvertance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, '..');

// Doit rester le miroir de PACKS (mode 'subscription') dans src/worker.ts.
const ABONNEMENTS = [
  { id: 'sub_starter', name: 'MyFabmesh Starter Monthly', euros: 5,  credits: 30 },
  { id: 'sub_pro',     name: 'MyFabmesh Pro Monthly',     euros: 15, credits: 100 },
  { id: 'sub_studio',  name: 'MyFabmesh Studio Monthly',  euros: 40, credits: 300 },
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
  console.error('Cle LIVE detectee. Ajoute --live pour confirmer que tu veux creer');
  console.error('des Prix en argent reel. Rien n\'a ete fait.');
  process.exit(2);
}

async function stripe(chemin, corps) {
  const opts = {
    method: corps ? 'POST' : 'GET',
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

console.log(`Mode : ${MODE}${APPLIQUER ? '' : '  (simulation — rien ne sera cree)'}`);
console.log();

const commandes = [];
let souci = false;

for (const p of ABONNEMENTS) {
  const lookup = `myfabmesh_${p.id}_eur_month`;
  const centimes = Math.round(p.euros * 100);

  // 1. Le Prix existe-t-il deja ? (idempotence)
  let existant = null;
  try {
    const q = await stripe(`prices?lookup_keys[]=${encodeURIComponent(lookup)}&active=true&limit=1`);
    existant = (q.data || [])[0] || null;
  } catch (e) {
    console.error(`  ${p.id} : lecture impossible — ${e.message}`);
    souci = true;
    continue;
  }

  if (existant) {
    const memeMontant = existant.unit_amount === centimes;
    const memeInterval = existant.recurring?.interval === 'month';
    console.log(`  ${p.id.padEnd(12)} deja present  ${existant.id}  ${(existant.unit_amount / 100).toFixed(2)} EUR/${existant.recurring?.interval}`);
    if (!memeMontant || !memeInterval) {
      // Un Prix Stripe est IMMUABLE : on ne peut pas le corriger, seulement
      // en creer un autre. On le dit franchement plutot que d'en empiler un
      // en douce, ce qui laisserait deux Prix actifs pour le meme pack.
      console.log(`  ${''.padEnd(12)} ATTENTION : le code annonce ${p.euros.toFixed(2)} EUR/month.`);
      console.log(`  ${''.padEnd(12)} Un Prix Stripe ne se modifie pas. Pour changer le montant :`);
      console.log(`  ${''.padEnd(12)}   1. archive ${existant.id} dans le tableau de bord,`);
      console.log(`  ${''.padEnd(12)}   2. relance ce script (le lookup_key sera libre).`);
      console.log(`  ${''.padEnd(12)} Les abonnes existants restent sur l'ancien Prix — c'est voulu.`);
      souci = true;
    }
    commandes.push([p.id, existant.id]);
    continue;
  }

  if (!APPLIQUER) {
    console.log(`  ${p.id.padEnd(12)} A CREER       ${p.euros.toFixed(2)} EUR/month, ${p.credits} credits`);
    continue;
  }

  // 2. Produit puis Prix.
  try {
    const produit = await stripe('products', {
      name: p.name,
      description: `${p.credits} credits per month`,
      'metadata[pack_id]': p.id,
      'metadata[credits]': String(p.credits),
    });
    const prix = await stripe('prices', {
      product: produit.id,
      currency: 'eur',
      unit_amount: String(centimes),
      'recurring[interval]': 'month',
      lookup_key: lookup,
      'metadata[pack_id]': p.id,
      'metadata[credits]': String(p.credits),
    });
    console.log(`  ${p.id.padEnd(12)} cree          ${prix.id}  ${p.euros.toFixed(2)} EUR/month`);
    commandes.push([p.id, prix.id]);
  } catch (e) {
    console.error(`  ${p.id.padEnd(12)} ECHEC : ${e.message}`);
    souci = true;
  }
}

console.log();
if (commandes.length) {
  console.log('A executer depuis cloud/ pour rendre les abonnements achetables :');
  console.log();
  for (const [id, prix] of commandes) {
    console.log(`  echo ${prix} | npx wrangler secret put STRIPE_PRICE_${id.toUpperCase()}`);
  }
  console.log();
  console.log('Puis verifier :');
  console.log('  curl -s https://myfabmesh-cloud.fabien65400.workers.dev/api/pricing/availability');
  console.log('  -> les trois sub_* doivent passer a true.');
} else if (!APPLIQUER) {
  console.log('Simulation terminee. Relance avec --apply pour creer.');
}

if (EST_LIVE) {
  console.log();
  console.log('RAPPEL mode LIVE : la cle secrete, le secret de webhook ET la cle');
  console.log('publiable de wrangler.toml doivent tous etre en live. Un melange');
  console.log('des deux modes fait echouer chaque paiement.');
}

process.exit(souci ? 3 : 0);
