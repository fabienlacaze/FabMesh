/**
 * Empreinte de version sur les assets de /app/ — etape POST-BUILD.
 *
 * POURQUOI
 * --------
 * out/app/* est copie verbatim depuis public/app/ par Next : les URLs sont
 * donc IMMUABLES (`/app/index2.js` aujourd'hui, `/app/index2.js` demain).
 * Cloudflare met ces assets en cache a la peripherie et, malgre un
 * `cache-control: max-age=0, must-revalidate`, on a constate a repetition le
 * 2026-07-27 que l'ancien fichier continuait d'etre servi plusieurs minutes
 * apres un deploiement — au point de faire croire trois fois dans la journee
 * qu'un correctif deploye « ne marchait pas ».
 *
 * CE QUE FAIT CE SCRIPT
 * ---------------------
 * Reecrit les references locales de out/app/index.html en y ajoutant
 * `?v=<empreinte du contenu>`. L'URL change donc a chaque fois que le FICHIER
 * change (et seulement dans ce cas : deux builds identiques donnent la meme
 * URL, le cache reste donc utile). Un cache ne peut plus servir l'ancienne
 * version : c'est une adresse differente.
 *
 * index.html lui-meme n'est pas empreinte — c'est le point d'entree. Il reste
 * couvert par `max-age=0, must-revalidate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_DIR = path.resolve('out/app');
const HTML = path.join(APP_DIR, 'index.html');

if (!fs.existsSync(HTML)) {
  console.log('[stamp-assets] out/app/index.html absent — rien a faire.');
  process.exit(0);
}

const empreinte = (rel) => {
  const f = path.join(APP_DIR, rel);
  if (!fs.existsSync(f)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
};

let html = fs.readFileSync(HTML, 'utf8');
let n = 0;
const vus = [];

// src="xxx.js" / href="xxx.css" LOCAUX uniquement (pas d'URL absolue, pas de
// protocole) et pas deja empreintes.
html = html.replace(
  /\b(src|href)="(?!https?:|\/\/|data:|#)([^"?#]+\.(?:js|css))"/g,
  (whole, attr, rel) => {
    const h = empreinte(rel);
    if (!h) return whole;                 // fichier hors de /app/ : on laisse
    n++; vus.push(`${rel} -> ${h}`);
    return `${attr}="${rel}?v=${h}"`;
  },
);

fs.writeFileSync(HTML, html);
console.log(`[stamp-assets] ${n} reference(s) empreintee(s) dans out/app/index.html`);
for (const v of vus) console.log('   ', v);
