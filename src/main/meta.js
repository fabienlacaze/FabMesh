// =============================================================================
// src/main/meta.js — lineage sidecar `<output>.meta.json` (Generation History)
// -----------------------------------------------------------------------------
// One uniform sidecar format for EVERY generated artefact (image, mesh, op
// output, rig, animation). Written best-effort at each generation step so the
// Generation History popup can show the full sequence WITH parameters — the
// filename only encodes the LAST op (OP_SUFFIX chains are flattened in
// main.js) and argv/env params were previously dropped after the subprocess.
//
//   { schema: 1,
//     kind:   'image' | 'mesh' | 'op' | 'rig' | 'anim',
//     op:     'segment' | 'smooth' | ...          (kind==='op' only)
//     engine: 'trellis2_native' | 'puppeteer' | ...
//     parent: '<abs path of the input mesh/rig>'  (explicit parent edge)
//     source: '<abs path of the source image>'    (when known)
//     params: { ...step parameters... },
//     ts:     Date.now() }
//
// Rules:
//  - writeMeta NEVER throws (a failed sidecar must never break a generation).
//  - readMeta returns null on any problem (missing / corrupt).
//  - Sidecar lives next to the artefact: `X.glb` -> `X.glb.meta.json`, so the
//    existing rename/delete sidecar sweeps can be extended by suffix match.
// =============================================================================

'use strict';

const fs = require('fs');

function writeMeta(outputPath, obj) {
  try {
    if (!outputPath || !obj) return false;
    const meta = Object.assign({ schema: 1, ts: Date.now() }, obj);
    // Drop undefined params so the JSON stays clean.
    if (meta.params && typeof meta.params === 'object') {
      for (const k of Object.keys(meta.params)) {
        if (meta.params[k] === undefined) delete meta.params[k];
      }
    }
    fs.writeFileSync(outputPath + '.meta.json', JSON.stringify(meta, null, 2), 'utf-8');
    return true;
  } catch (_) { return false; }
}

function readMeta(outputPath) {
  try {
    const p = outputPath + '.meta.json';
    if (!fs.existsSync(p)) return null;
    const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (meta && typeof meta === 'object') ? meta : null;
  } catch (_) { return null; }
}

module.exports = { writeMeta, readMeta };
