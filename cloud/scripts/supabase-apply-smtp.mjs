#!/usr/bin/env node
/**
 * Idempotent script to configure the live Supabase project's Auth SMTP
 * (the sender used for signup-confirmation / password-reset / magic-link
 * emails) via the Management API — the companion to
 * supabase-apply-email-templates.mjs.
 *
 * Why this exists:
 *   The project was wired to Resend's SANDBOX sender `onboarding@resend.dev`,
 *   which only delivers to the Resend account owner's own address. Every other
 *   recipient (friends, the MS Store reviewer) got "Error sending confirmation
 *   email". A real sender fixes signup end-to-end. Cheapest robust option with
 *   NO domain: a free Gmail as the SMTP relay (app password). Later, swap to a
 *   verified domain (Resend/Brevo) by editing build/smtp-config.json + re-run.
 *
 * Requirements (all SECRET — kept OUT of git):
 *   1. A Supabase Personal Access Token (PAT), same as the templates script:
 *        - env var SUPABASE_PAT, or
 *        - build/supabase-pat.txt (gitignored) with an `sbp_...` token.
 *   2. SMTP credentials, at one of:
 *        - build/smtp-config.json (gitignored — copy build/smtp-config.example.json), or
 *        - env vars SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SENDER, SMTP_SENDER_NAME
 *
 * Gmail relay setup (free, no domain):
 *   - Enable 2-Step Verification on the Google account.
 *   - Google Account > Security > App passwords > generate a 16-char password.
 *   - host smtp.gmail.com, port 465, user = the full gmail, pass = that app
 *     password, sender = the same gmail. (~500 recipients/day, plenty to test.)
 *
 * Run from repo root:
 *   node cloud/scripts/supabase-apply-smtp.mjs
 *   node cloud/scripts/supabase-apply-smtp.mjs --dry-run   # print, don't PATCH
 */
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_REF = 'ovoccoipeqmkfnugkmyh';
const DRY = process.argv.includes('--dry-run');

function readPat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT.trim();
  const fallback = path.resolve(process.cwd(), 'build', 'supabase-pat.txt');
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8').trim();
  throw new Error(
    'No Supabase PAT found. Set SUPABASE_PAT env var, or create '
    + 'build/supabase-pat.txt (gitignored) with an sbp_... token '
    + '(Supabase dashboard > Account > Access Tokens).',
  );
}

function readSmtpConfig() {
  // 1) explicit JSON sidecar (gitignored)
  const jsonPath = path.resolve(process.cwd(), 'build', 'smtp-config.json');
  let cfg = {};
  if (fs.existsSync(jsonPath)) {
    try { cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch (e) { throw new Error(`build/smtp-config.json is not valid JSON: ${e.message}`); }
  }
  // 2) env-var overrides (win over the file so CI can inject secrets)
  const host   = process.env.SMTP_HOST        ?? cfg.host;
  const port   = process.env.SMTP_PORT        ?? cfg.port;
  const user   = process.env.SMTP_USER        ?? cfg.user;
  const pass   = process.env.SMTP_PASS        ?? cfg.pass;
  const sender = process.env.SMTP_SENDER      ?? cfg.sender ?? user;
  const name   = process.env.SMTP_SENDER_NAME ?? cfg.sender_name ?? 'MyFabmesh.AI';

  const missing = [];
  if (!host) missing.push('host / SMTP_HOST');
  if (!port) missing.push('port / SMTP_PORT');
  if (!user) missing.push('user / SMTP_USER');
  if (!pass) missing.push('pass / SMTP_PASS');
  if (missing.length) {
    throw new Error(
      'Missing SMTP settings: ' + missing.join(', ') + '.\n'
      + 'Copy build/smtp-config.example.json to build/smtp-config.json and fill it in '
      + '(the file is gitignored), or set the SMTP_* env vars.',
    );
  }
  if (String(sender).includes('onboarding@resend.dev')) {
    throw new Error(
      'Refusing to set sender = onboarding@resend.dev — that is Resend\'s SANDBOX '
      + 'address (delivers only to your own inbox). Use a real mailbox (e.g. a Gmail '
      + 'with an app password) or a verified-domain address.',
    );
  }
  return { host: String(host), port: Number(port), user: String(user), pass: String(pass), sender: String(sender), name: String(name) };
}

const pat = readPat();
const smtp = readSmtpConfig();

// Supabase Management API auth-config fields (mirror GoTrue GOTRUE_SMTP_*).
// Providing smtp_host/user/pass enables custom SMTP; mailer_autoconfirm=false
// keeps email verification ON (the robust flow — the 6-digit code in the
// templates). external_email_enabled keeps email sign-in available.
const body = {
  external_email_enabled: true,
  mailer_autoconfirm: false,
  smtp_host: smtp.host,
  smtp_port: smtp.port,
  smtp_user: smtp.user,
  smtp_pass: smtp.pass,
  smtp_admin_email: smtp.sender,
  smtp_sender_name: smtp.name,
};

const redacted = { ...body, smtp_pass: '••••••••(hidden)' };
console.log(`[smtp] project=${PROJECT_REF}`);
console.log('[smtp] config to apply:', JSON.stringify(redacted, null, 2));

if (DRY) {
  console.log('[smtp] --dry-run: nothing sent.');
  process.exit(0);
}

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`,
  {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  },
);

if (!res.ok) {
  console.error(`[FAIL] HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const result = await res.json();
console.log('[OK] SMTP applied. Live values:');
console.log('  smtp_host        →', result.smtp_host);
console.log('  smtp_port        →', result.smtp_port);
console.log('  smtp_admin_email →', result.smtp_admin_email);
console.log('  smtp_sender_name →', result.smtp_sender_name);
console.log('  mailer_autoconfirm →', result.mailer_autoconfirm, '(false = email verification required)');
console.log('\nNext: sign up with a REAL email you can open, confirm you receive the 6-digit code.');
