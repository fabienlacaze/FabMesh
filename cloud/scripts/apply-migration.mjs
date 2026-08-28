#!/usr/bin/env node
/**
 * Applique UNE migration nommee sur la base, avec sonde AVANT / APRES.
 *
 * POURQUOI PAS `supabase db push`
 * -------------------------------
 * `db push` rejoue tout ce que la table `schema_migrations` ne connait pas.
 * Or prod et migrations ont deja diverge sur ce projet : la colonne
 * `anonymise_le` a ete ajoutee a la main, hors migration, et
 * `schema_migrations` ne liste que quatre entrees de mai/juin. Un `push`
 * relancerait donc des fichiers dont l'effet est deja partiellement en base.
 *
 * Le precedent existe : le 2026-08-18, un `supabase config push` applique
 * sans etre demande a casse l'authentification. On applique donc UN fichier,
 * choisi explicitement, et on MESURE l'etat avant et apres.
 *
 * USAGE
 *   node scripts/apply-migration.mjs <fichier.sql>            # simulation
 *   node scripts/apply-migration.mjs <fichier.sql> --apply    # applique
 *
 * Les identifiants sont lus dans cloud/.env.local
 * (NEXT_PUBLIC_SUPABASE_URL pour la reference du projet, SUPABASE_DB_PASSWORD).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, '..');

const args = process.argv.slice(2);
const APPLIQUER = args.includes('--apply');
const nom = args.find((a) => !a.startsWith('--'));

if (!nom) {
  console.error('Usage : node scripts/apply-migration.mjs <fichier.sql> [--apply]');
  console.error('Migrations disponibles :');
  for (const f of fs.readdirSync(path.join(RACINE, 'supabase/migrations')).sort()) {
    console.error(`  ${f}`);
  }
  process.exit(1);
}

const chemin = fs.existsSync(nom)
  ? nom
  : path.join(RACINE, 'supabase/migrations', nom);
if (!fs.existsSync(chemin)) {
  console.error(`Introuvable : ${chemin}`);
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(path.join(RACINE, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const ref = (env.NEXT_PUBLIC_SUPABASE_URL || '')
  .match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref || !env.SUPABASE_DB_PASSWORD) {
  console.error('NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_DB_PASSWORD manquant dans cloud/.env.local');
  process.exit(1);
}

/* Sonde specifique a `payments` : l'etat des deux verrous qui empechaient
 * l'anonymisation comptable, plus la colonne qui la date. Volontairement
 * codee en dur — une sonde generique ne dirait rien d'utile. */
const SONDE = `
  select
    (select is_nullable from information_schema.columns
      where table_schema='public' and table_name='payments' and column_name='user_id')
      as user_id_nullable,
    (select count(*)::int from information_schema.columns
      where table_schema='public' and table_name='payments' and column_name='anonymise_le')
      as colonne_anonymise_le,
    (select confdeltype from pg_constraint
      where conrelid='public.payments'::regclass and contype='f'
        and conkey @> array[(select attnum from pg_attribute
             where attrelid='public.payments'::regclass and attname='user_id')])
      as fk_suppression,
    (select count(*)::int from public.payments) as lignes`;

const c = new pg.Client({
  host: 'aws-0-eu-west-3.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

await c.connect();

const decrire = (r) =>
  `user_id nullable=${r.user_id_nullable}, anonymise_le=${r.colonne_anonymise_le ? 'oui' : 'non'}, `
  + `ON DELETE=${{ c: 'CASCADE', n: 'SET NULL', a: 'NO ACTION', r: 'RESTRICT' }[r.fk_suppression] || r.fk_suppression}, `
  + `${r.lignes} ligne(s)`;

const avant = (await c.query(SONDE)).rows[0];
console.log(`AVANT : ${decrire(avant)}`);

if (!APPLIQUER) {
  console.log('\n(simulation — relance avec --apply pour appliquer)');
  console.log(`Fichier : ${chemin}`);
  await c.end();
  process.exit(0);
}

await c.query(fs.readFileSync(chemin, 'utf8'));

const apres = (await c.query(SONDE)).rows[0];
console.log(`APRES : ${decrire(apres)}`);

if (avant.lignes !== apres.lignes) {
  console.error(`\nALERTE : le nombre de lignes a change (${avant.lignes} -> ${apres.lignes}).`);
  await c.end();
  process.exit(2);
}

const ok = apres.user_id_nullable === 'YES'
        && apres.colonne_anonymise_le === 1
        && apres.fk_suppression === 'n';
console.log(ok
  ? '\nOK — l anonymisation comptable est desormais possible : une suppression de compte\n'
    + '     delie la ligne au lieu de la detruire (art. L102 B LPF, six ans).'
  : '\nINCOMPLET — un des trois verrous n a pas saute, voir la ligne APRES.');

await c.end();
process.exit(ok ? 0 : 1);
