#!/usr/bin/env node
/**
 * MyFabmesh.AI Cloud — Supabase project provisioning automation.
 *
 * Does (in order):
 *  1. Ask you for a Supabase Personal Access Token (PAT) created on
 *     https://supabase.com/dashboard/account/tokens
 *  2. supabase login --token <PAT>
 *  3. List orgs → pick one (auto if single)
 *  4. Generate a random DB password
 *  5. Create project "myfabmesh-cloud" in West EU
 *  6. Pull API keys (URL + anon + service_role)
 *  7. Init local `supabase/` directory with migrations + push schema.sql
 *  8. Update cloud/.env.local with real keys + MOCK=0
 *  9. Rebuild Next.js
 *
 * You can re-run safely: existing project is detected and reused.
 *
 * Usage:
 *   node scripts/supabase-setup.mjs
 *   node scripts/supabase-setup.mjs --token <PAT>   # non-interactive
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_LOCAL = join(ROOT, '.env.local');
const SCHEMA = join(ROOT, 'sql', 'schema.sql');
const PROJECT_NAME = process.env.SUPABASE_PROJECT_NAME || 'myfabmesh-cloud';
const REGION = process.env.SUPABASE_REGION || 'eu-west-3';

function log(msg, kind = 'info') {
  const colors = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m' };
  console.log(`${colors[kind]}${msg}\x1b[0m`);
}

function run(cmd, opts = {}) {
  if (opts.verbose !== false) log(`$ ${cmd}`, 'info');
  return execSync(cmd, { encoding: 'utf-8', stdio: opts.pipe ? 'pipe' : ['inherit', 'pipe', 'inherit'], ...opts });
}
function runJson(cmd) {
  const out = run(cmd, { verbose: false, pipe: true });
  return JSON.parse(out);
}

async function main() {
  // ─── 0. checks ─────────────────────────────────────────────
  log('\n┌─ MyFabmesh.AI Cloud — Supabase auto-provisioning ─────', 'ok');
  log('│ Time budget: ~5 minutes', 'ok');
  log('└────────────────────────────────────────────────────────\n', 'ok');

  try { run('supabase --version', { verbose: false, pipe: true }); }
  catch { log('❌ supabase CLI not found. Install it first.', 'err'); process.exit(1); }
  if (!existsSync(SCHEMA)) { log(`❌ schema.sql missing at ${SCHEMA}`, 'err'); process.exit(1); }

  // ─── 1. PAT ────────────────────────────────────────────────
  let token = process.env.SUPABASE_ACCESS_TOKEN;
  const argIdx = process.argv.indexOf('--token');
  if (argIdx > 0) token = process.argv[argIdx + 1];

  if (!token) {
    log('Step 1/8 — Personal Access Token', 'info');
    log('Create one on https://supabase.com/dashboard/account/tokens', 'info');
    log('  Name suggestion: "myfabmesh-cloud-cli"', 'info');
    log('  Scope: it is a full-access PAT (Supabase has no granular scopes for PATs)', 'info');
    const rl = readline.createInterface({ input, output });
    token = (await rl.question('Paste token (sbp_…): ')).trim();
    rl.close();
    if (!/^sbp_/.test(token)) {
      log('⚠ Warning: token should usually start with "sbp_". Continuing anyway.', 'warn');
    }
  }

  // ─── 2. login ──────────────────────────────────────────────
  log('\nStep 2/8 — Authenticate CLI', 'info');
  process.env.SUPABASE_ACCESS_TOKEN = token;
  try {
    run(`supabase login --token ${token} --name "myfabmesh-cloud-${Date.now()}"`, { verbose: false, pipe: true });
    log('  ✓ logged in', 'ok');
  } catch (err) {
    log(`❌ login failed: ${err.message?.split('\n')[0] || err}`, 'err');
    process.exit(1);
  }

  // ─── 3. orgs ───────────────────────────────────────────────
  log('\nStep 3/8 — List organizations', 'info');
  const orgsRaw = run('supabase orgs list -o json', { verbose: false, pipe: true });
  const orgs = JSON.parse(orgsRaw);
  if (!orgs.length) { log('❌ no organizations on your account', 'err'); process.exit(1); }
  let orgId;
  if (orgs.length === 1) {
    orgId = orgs[0].id;
    log(`  ✓ single org: ${orgs[0].name} (${orgId})`, 'ok');
  } else {
    log('  Multiple orgs — pick one:', 'info');
    orgs.forEach((o, i) => console.log(`  [${i}] ${o.name} (${o.id})`));
    const rl = readline.createInterface({ input, output });
    const pick = parseInt(await rl.question(`Index (default 0): `)) || 0;
    rl.close();
    orgId = orgs[pick].id;
  }

  // ─── 4. find or create project ─────────────────────────────
  log('\nStep 4/8 — Find or create project', 'info');
  const projectsRaw = run('supabase projects list -o json', { verbose: false, pipe: true });
  const projects = JSON.parse(projectsRaw);
  let project = projects.find((p) => p.name === PROJECT_NAME && p.organization_id === orgId);

  if (project) {
    log(`  ✓ existing project found: ${project.name} (ref=${project.id})`, 'ok');
  } else {
    log(`  Creating new project "${PROJECT_NAME}" in ${REGION}…`, 'info');
    const dbPassword = randomBytes(18).toString('base64url');
    log(`  Generated DB password: ${dbPassword}`, 'warn');
    log('  (saved to .env.local under SUPABASE_DB_PASSWORD)', 'warn');
    const cmd = `supabase projects create ${PROJECT_NAME} --org-id ${orgId} --db-password "${dbPassword}" --region ${REGION} -o json`;
    const createRaw = run(cmd, { verbose: false, pipe: true });
    project = JSON.parse(createRaw);
    project._dbPassword = dbPassword;
    log(`  ✓ created: ref=${project.id}`, 'ok');
    log('  Provisioning takes ~2 min — waiting…', 'info');
    await sleep(120_000);
  }

  // ─── 5. api keys ───────────────────────────────────────────
  log('\nStep 5/8 — Fetch API keys', 'info');
  const keysRaw = run(`supabase projects api-keys --project-ref ${project.id} -o json`, { verbose: false, pipe: true });
  const keys = JSON.parse(keysRaw);
  const anon = keys.find((k) => k.name === 'anon')?.api_key;
  const service = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!anon || !service) { log('❌ could not parse API keys', 'err'); process.exit(1); }
  const supabaseUrl = `https://${project.id}.supabase.co`;
  log(`  ✓ URL: ${supabaseUrl}`, 'ok');
  log(`  ✓ anon key + service_role retrieved`, 'ok');

  // ─── 6. init local supabase directory & link ───────────────
  log('\nStep 6/8 — Link local CLI to remote', 'info');
  const supaDir = join(ROOT, 'supabase');
  if (!existsSync(supaDir)) {
    mkdirSync(supaDir, { recursive: true });
    mkdirSync(join(supaDir, 'migrations'), { recursive: true });
    writeFileSync(join(supaDir, 'config.toml'), `project_id = "${project.id}"\n`);
    log(`  ✓ created supabase/ dir`, 'ok');
  }
  // copy schema.sql into a versioned migration
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const migName = `${ts}_init_schema.sql`;
  const migPath = join(supaDir, 'migrations', migName);
  if (!existsSync(migPath)) {
    copyFileSync(SCHEMA, migPath);
    log(`  ✓ migration copied: ${migName}`, 'ok');
  } else {
    log(`  ✓ migration already exists`, 'ok');
  }

  const dbPassword = project._dbPassword || readEnv('SUPABASE_DB_PASSWORD');
  if (!dbPassword) {
    log('  ⚠ DB password not in .env.local — re-running on an existing project', 'warn');
    log('  You need to push schema manually via SQL editor:', 'warn');
    log(`    1. Open https://supabase.com/dashboard/project/${project.id}/sql/new`, 'warn');
    log(`    2. Paste content of ${SCHEMA} and Run.`, 'warn');
  } else {
    try {
      run(`supabase link --project-ref ${project.id} --password "${dbPassword}"`, { verbose: false, cwd: ROOT, pipe: true });
      log('  ✓ linked', 'ok');
    } catch (err) {
      log(`  ⚠ link warning: ${err.message?.split('\n')[0]}`, 'warn');
    }

    // ─── 7. push schema ─────────────────────────────────────
    log('\nStep 7/8 — Push schema to remote', 'info');
    try {
      run(`supabase db push --linked --password "${dbPassword}"`, { verbose: false, cwd: ROOT, pipe: true });
      log('  ✓ schema applied', 'ok');
    } catch (err) {
      log(`  ⚠ push had issues — usually because tables already exist (idempotent schema is OK).`, 'warn');
      log(`  Details: ${(err.stdout || err.stderr || err.message || '').toString().split('\n').slice(0, 3).join(' / ')}`, 'warn');
    }
  }

  // ─── 8. write .env.local ───────────────────────────────────
  log('\nStep 8/8 — Update .env.local', 'info');
  const env = readEnvFile();
  env['MOCK'] = '0';
  env['NEXT_PUBLIC_MOCK'] = '0';
  env['NEXT_PUBLIC_SUPABASE_URL'] = supabaseUrl;
  env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = anon;
  env['SUPABASE_SERVICE_ROLE_KEY'] = service;
  if (project._dbPassword) env['SUPABASE_DB_PASSWORD'] = project._dbPassword;
  if (!env['REPLICATE_API_TOKEN'] || env['REPLICATE_API_TOKEN'] === 'mock') {
    // bring in the real token from repo if present
    const tokenFile = join(ROOT, '..', 'build', 'replicate-token.txt');
    if (existsSync(tokenFile)) {
      env['REPLICATE_API_TOKEN'] = readFileSync(tokenFile, 'utf-8').trim();
      log('  ✓ wired Replicate token from build/replicate-token.txt', 'ok');
    }
  }
  if (!env['REPLICATE_MODEL'] || env['REPLICATE_MODEL'] === 'mock') {
    env['REPLICATE_MODEL'] = 'fishwowater/trellis2';
  }
  if (!env['NEXT_PUBLIC_SITE_URL']) env['NEXT_PUBLIC_SITE_URL'] = 'http://localhost:3030';
  // ensure stripe + r2 keys exist (placeholders)
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
                   'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL']) {
    if (!(k in env)) env[k] = '';
  }
  writeEnvFile(env);
  log('  ✓ .env.local updated (MOCK=0, real Supabase keys wired)', 'ok');

  log('\n──────────────────────────────────────────────────────', 'ok');
  log('✓ Supabase is live. Next steps:', 'ok');
  log('  1. Test signin:  npm run dev → http://localhost:3030/login', 'info');
  log(`  2. View tables:  https://supabase.com/dashboard/project/${project.id}/editor`, 'info');
  log(`  3. SQL editor:   https://supabase.com/dashboard/project/${project.id}/sql/new`, 'info');
  log('  4. Set Stripe + R2 keys next (see GOING_LIVE.md), or test with mock R2 fallback (Replicate URLs valid 24h).', 'info');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readEnv(key) {
  return readEnvFile()[key];
}
function readEnvFile() {
  if (!existsSync(ENV_LOCAL)) return {};
  const env = {};
  for (const line of readFileSync(ENV_LOCAL, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2];
  }
  return env;
}
function writeEnvFile(env) {
  const order = [
    'MOCK', 'NEXT_PUBLIC_MOCK',
    'NEXT_PUBLIC_SITE_URL',
    'REPLICATE_API_TOKEN', 'REPLICATE_MODEL', 'REPLICATE_VERSION',
    'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_PASSWORD',
    'STRIPE_SECRET_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET',
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL',
  ];
  const seen = new Set();
  let out = `# Generated by scripts/supabase-setup.mjs on ${new Date().toISOString()}\n`;
  for (const k of order) {
    if (k in env) { out += `${k}=${env[k]}\n`; seen.add(k); }
  }
  for (const k of Object.keys(env)) {
    if (!seen.has(k)) out += `${k}=${env[k]}\n`;
  }
  writeFileSync(ENV_LOCAL, out, 'utf-8');
}

main().catch((err) => {
  log(`\n❌ FATAL: ${err.message || err}`, 'err');
  if (err.stdout) log(String(err.stdout).slice(0, 800), 'err');
  if (err.stderr) log(String(err.stderr).slice(0, 800), 'err');
  process.exit(1);
});
