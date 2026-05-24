#!/usr/bin/env node
/**
 * Idempotent script to push the 4 branded Auth email templates
 * (and matching subjects) to the live Supabase project via the
 * Management API.
 *
 * Why this exists:
 *   The dashboard manual paste is brittle (templates revert if
 *   someone clicks "Reset to default"). Running this script restores
 *   the canonical brand HTML in seconds and can be wired into CI later.
 *
 * Requirements:
 *   - A Supabase Personal Access Token (PAT) at one of:
 *       1. env var SUPABASE_PAT
 *       2. build/supabase-pat.txt (gitignored sidecar — created on
 *          first use by pasting `sbp_...` into that file)
 *   - The 4 HTML files in cloud/supabase/email-templates/
 *
 * Run from repo root:
 *   node cloud/scripts/supabase-apply-email-templates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_REF = 'ovoccoipeqmkfnugkmyh';
const TEMPLATES_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/, '')),
  '..', 'supabase', 'email-templates',
);

function readPat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT.trim();
  const fallback = path.resolve(process.cwd(), 'build', 'supabase-pat.txt');
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8').trim();
  throw new Error(
    'No Supabase PAT found. Set SUPABASE_PAT env var, or create '
    + 'build/supabase-pat.txt (gitignored) with an sbp_... token.',
  );
}

function readTemplate(name) {
  const p = path.join(TEMPLATES_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`Missing template: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

const pat = readPat();
const body = {
  // Subjects shown in the recipient's inbox.
  mailer_subjects_magic_link:    'Your MyFabmesh.AI sign-in link',
  mailer_subjects_confirmation:  'Welcome to MyFabmesh.AI — confirm your account',
  mailer_subjects_recovery:      'Reset your MyFabmesh.AI password',
  mailer_subjects_email_change:  'Confirm your new MyFabmesh.AI email',

  // HTML bodies — read straight from disk so the on-disk version
  // is the single source of truth.
  mailer_templates_magic_link_content:    readTemplate('magic-link.html'),
  mailer_templates_confirmation_content:  readTemplate('confirm-signup.html'),
  mailer_templates_recovery_content:      readTemplate('reset-password.html'),
  mailer_templates_email_change_content:  readTemplate('change-email.html'),
};

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`,
  {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  },
);

if (!res.ok) {
  console.error(`[FAIL] HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const result = await res.json();
const customFlags = result.mailer_templates_custom_contents ?? {};
console.log('[OK] Templates applied. Custom flags:');
console.log('  MAGIC_LINK    →', customFlags.MAILER_TEMPLATES_MAGIC_LINK_CONTENT);
console.log('  CONFIRMATION  →', customFlags.MAILER_TEMPLATES_CONFIRMATION_CONTENT);
console.log('  RECOVERY      →', customFlags.MAILER_TEMPLATES_RECOVERY_CONTENT);
console.log('  EMAIL_CHANGE  →', customFlags.MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT);
