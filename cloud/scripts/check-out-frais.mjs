#!/usr/bin/env node
/**
 * Refuse un deploiement dont `out/` est plus vieux que les sources.
 *
 * POURQUOI (mesure du 2026-08-23). `wrangler.toml` sert les assets depuis
 * `[assets] directory = "out"`. Modifier `public/app/*.js` ne suffit donc
 * pas : sans `npm run build`, wrangler republie l'ancien `out/` — et il le
 * fait SANS RIEN DIRE, en affichant un deploiement reussi.
 *
 * Ce jour-la le piege s'est referme deux fois de suite :
 *   - `npm run build` a echoue sur le garde des mentions legales ;
 *   - la commande etait `npm run build | tail -2 && wrangler deploy`, or le
 *     code de sortie d'un tube est celui de `tail`, pas du build. Le `&&`
 *     n'a donc rien retenu.
 * Resultat : trois correctifs verifies en local, absents de la production,
 * et un controle qui repondait « 0 » sans qu'on sache pourquoi.
 *
 * Ce garde compare la date de `out/` a celle des sources. Il ne remplace pas
 * le build : il rend son oubli visible AVANT la publication.
 *
 * Lance par `predeploy` — donc par `npm run deploy`, pas par
 * `npx wrangler deploy`, qui court-circuite les scripts npm. Deployer par
 * `npm run deploy`.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Date de modification la plus recente sous `chemin`, en ms. */
function plusRecent(chemin, ignorer = new Set()) {
  if (!existsSync(chemin)) return 0;
  let max = 0;
  const pile = [chemin];
  while (pile.length) {
    const p = pile.pop();
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      let entrees;
      try { entrees = readdirSync(p); } catch { continue; }
      for (const e of entrees) {
        if (ignorer.has(e)) continue;
        pile.push(join(p, e));
      }
    } else if (st.mtimeMs > max) {
      max = st.mtimeMs;
    }
  }
  return max;
}

const out = plusRecent(join(racine, 'out'));
if (!out) {
  console.error('\n[out] `out/` est ABSENT — rien ne serait publie.\n'
              + '      Lancer : npm run build\n');
  process.exit(1);
}

const ignorer = new Set(['node_modules', '.next', 'out', '.wrangler']);
const sources = Math.max(
  plusRecent(join(racine, 'public'), ignorer),
  plusRecent(join(racine, 'src'), ignorer),
);

if (sources > out) {
  const retard = Math.round((sources - out) / 1000);
  console.error(
    '\n========================================================================\n'
  + '  DEPLOIEMENT REFUSE : `out/` est PLUS VIEUX que les sources.\n'
  + `  Retard : ${retard} s.\n\n`
  + '  wrangler publie les assets depuis `out/`, pas depuis `public/`.\n'
  + '  Deployer maintenant republierait la version PRECEDENTE de l\'interface,\n'
  + '  en affichant un deploiement reussi.\n\n'
  + '  Lancer : npm run build\n'
  + '  (si le garde des mentions legales bloque : ALLOW_UNFILLED_LEGAL=1 npm run build)\n'
  + '========================================================================\n');
  process.exit(1);
}

console.log(`[out] a jour (${new Date(out).toISOString()}) — publication autorisee`);
