#!/usr/bin/env node
/**
 * Re-sync the desktop renderer into cloud/public/app/.
 *
 * Run after any UI change in src/renderer/. It copies the latest files,
 * then re-applies the cloud-specific patches (CSP, importmap CDN, shim
 * injection) so the cloud app stays in sync without manual diffing.
 *
 * Usage:
 *   npm run sync-app
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUD = join(__dirname, '..');
const REPO  = join(CLOUD, '..');
const SRC   = join(REPO, 'src', 'renderer');
const DEST  = join(CLOUD, 'public', 'app');

function log(msg, kind = 'info') {
  const colors = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m' };
  console.log(`${colors[kind]}${msg}\x1b[0m`);
}

const FILES = [
  ['index2.html',              'index.html'],
  ['index2.js',                'index2.js'],
  ['index2-edit-tools.js',     'index2-edit-tools.js'],
  ['canvas-utils.js',          'canvas-utils.js'],
  ['styles/main.css',          'styles/main.css'],
  ['styles/index2.css',        'styles/index2.css'],
  ['lib/Viewer3D.js',          'lib/Viewer3D.js'],
  ['lib/three.module.js',      'lib/three.module.js'],
];

log('\n┌─ Syncing desktop renderer → cloud/public/app/ ─', 'ok');

mkdirSync(join(DEST, 'styles'), { recursive: true });
mkdirSync(join(DEST, 'lib'), { recursive: true });

let copied = 0;
for (const [src, dest] of FILES) {
  const s = join(SRC, src);
  const d = join(DEST, dest);
  if (!existsSync(s)) { log(`  ✗ missing source: ${src}`, 'warn'); continue; }
  mkdirSync(dirname(d), { recursive: true });
  copyFileSync(s, d);
  copied++;
}
log(`  ✓ ${copied}/${FILES.length} files copied`, 'ok');

// ─── Patch index.html for cloud ─────────────────────────────────
const htmlPath = join(DEST, 'index.html');
let html = readFileSync(htmlPath, 'utf-8');

// 1. CSP: allow connects to api routes + CDN
html = html.replace(
  /<meta http-equiv="Content-Security-Policy"[^>]*>/,
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' blob: https://replicate.delivery https://*.r2.cloudflarestorage.com https://*.r2.dev https://unpkg.com; media-src 'self' blob: https:; frame-src 'self' blob:">`
);

// 2. Title: brand as Cloud
html = html.replace(/<title>MyFabmesh\.AI<\/title>/, '<title>MyFabmesh.AI Cloud</title>');

// 3. Inject the meshyAPI-cloud shim before any other <script>
if (!html.includes('meshyAPI-cloud.js')) {
  html = html.replace(
    /(<link rel="stylesheet" href="styles\/index2\.css">)/,
    `$1\n  <!-- Cloud shim: replaces Electron IPC with HTTP fetch. MUST load before index2.js. -->\n  <script src="meshyAPI-cloud.js"></script>`
  );
}

// 4. importmap → CDN unpkg (no node_modules in browser)
html = html.replace(
  /"three":\s*"\.\.\/\.\.\/node_modules\/three\/build\/three\.module\.js"/,
  `"three": "https://unpkg.com/three@0.170.0/build/three.module.js"`
);
html = html.replace(
  /"three\/addons\/":\s*"\.\.\/\.\.\/node_modules\/three\/examples\/jsm\/"/,
  `"three/addons/": "https://unpkg.com/three@0.170.0/examples/jsm/"`
);

// 5. Skip test_api_client.js (desktop-only dev bridge)
html = html.replace(
  /<script src="test_api_client\.js"><\/script>\n?/,
  '<!-- test_api_client.js skipped — desktop-only dev bridge -->\n  '
);

writeFileSync(htmlPath, html, 'utf-8');
log('  ✓ index.html patched (CSP, title, shim, importmap)', 'ok');

log('└────────────────────────────────────────────────\n', 'ok');
log('Sync done. Test with: npm run dev', 'info');
log('Then open: http://localhost:3030/app/', 'info');
