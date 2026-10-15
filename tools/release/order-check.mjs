// Reproduce framework.js orderPlugins() over the REAL discovery result, with and without the
// loadAfter/requirements fields, so the claim in docs/20 is measured rather than asserted.
//
//   node tools/release/order-check.mjs [pluginsDir]
//
// It re-implements exactly two things from the project: scanPlugins()'s ordering (directory names,
// sorted) and framework.js's orderPlugins() DFS.  The manifest is read out of each real .plugin
// archive, so the input is the shipped plugin set, not a fixture.

import { readdirSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';

const DIR = process.argv[2] || 'C:\\betterncm\\plugins';

/** Same central-directory walk as readZipArchive(): return manifest.json of one archive. */
function readManifest(file) {
  const buf = readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) throw new Error(`${file}: not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  const shift = eocd - buf.readUInt32LE(eocd + 12) - buf.readUInt32LE(eocd + 16);
  let p = buf.readUInt32LE(eocd + 16) + shift;
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'manifest.json') {
      const localOff = buf.readUInt32LE(p + 42) + shift;
      const lName = buf.readUInt16LE(localOff + 26);
      const lExtra = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lName + lExtra;
      const raw = buf.subarray(start, start + compSize);
      const json = (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
      return JSON.parse(json);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${file}: no manifest.json`);
}

/** framework.js orderPlugins(), same structure. */
function orderPlugins(list) {
  const bySlug = {};
  list.forEach((p) => { if (p.manifest) bySlug[p.manifest.slug] = p; });
  const out = [];
  const seen = {};
  function visit(p, depth) {
    if (!p || !p.manifest || seen[p.manifest.slug] || depth > 8) return;
    seen[p.manifest.slug] = true;
    const after = [].concat(p.manifest.loadAfter || [], p.manifest.requirements || []);
    after.forEach((slug) => { if (bySlug[slug]) visit(bySlug[slug], depth + 1); });
    out.push(p);
  }
  list.forEach((p) => visit(p, 0));
  return out;
}

const files = readdirSync(DIR).filter((n) => n.endsWith('.plugin')).sort();
const discovered = files.map((n) => ({ file: n, manifest: readManifest(join(DIR, n)) }));

console.log('plugins dir            :', DIR);
console.log('discovery order        :', discovered.map((e) => e.manifest.slug).join(' -> '));
console.log('declared edges         :', discovered
  .flatMap((e) => [].concat(e.manifest.loadAfter || [], e.manifest.requirements || [])
    .map((d) => `${e.manifest.slug} after ${d}`))
  .join(', ') || '(none)');

const before = discovered.map((e) => ({
  manifest: Object.assign({}, e.manifest, { loadAfter: undefined, requirements: undefined }),
}));
console.log('order BEFORE the fix   :', orderPlugins(before).map((p) => p.manifest.slug).join(' -> '));

const after = discovered.map((e) => ({
  manifest: Object.assign({}, e.manifest, {
    loadAfter: Array.isArray(e.manifest.loadAfter) ? e.manifest.loadAfter : [],
    requirements: Array.isArray(e.manifest.requirements) ? e.manifest.requirements : [],
  }),
}));
console.log('order AFTER the fix    :', orderPlugins(after).map((p) => p.manifest.slug).join(' -> '));
