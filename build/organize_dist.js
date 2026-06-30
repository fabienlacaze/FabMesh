// Post-build tidy. electron-builder always writes to dist/installer/ (its
// directories.output). This sorts that flat output into two subfolders so
// the .exe channel and the Microsoft Store channel stay separated:
//   *.appx                          -> dist/installer/MicrosoftStore/
//   everything else (exe, blockmap, -> dist/installer/InstallEXE/
//     latest.yml, win-unpacked, ...)
// Run automatically by the build:* npm scripts. Idempotent + safe to re-run.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'dist', 'installer');
const EXE_DIR = path.join(OUT, 'InstallEXE');
const STORE_DIR = path.join(OUT, 'MicrosoftStore');
const KEEP = new Set(['InstallEXE', 'MicrosoftStore']);

if (!fs.existsSync(OUT)) {
  console.log('[organize-dist] no dist/installer — nothing to do');
  process.exit(0);
}
fs.mkdirSync(EXE_DIR, { recursive: true });
fs.mkdirSync(STORE_DIR, { recursive: true });

let toExe = 0, toStore = 0;
for (const name of fs.readdirSync(OUT)) {
  if (KEEP.has(name)) continue;
  const src = path.join(OUT, name);
  const isAppx = name.toLowerCase().endsWith('.appx');
  const target = path.join(isAppx ? STORE_DIR : EXE_DIR, name);
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(src, target);
    if (isAppx) toStore++; else toExe++;
  } catch (e) {
    console.warn('[organize-dist] could not move ' + name + ': ' + (e && e.message));
  }
}
console.log('[organize-dist] InstallEXE: +' + toExe + ' | MicrosoftStore: +' + toStore);
