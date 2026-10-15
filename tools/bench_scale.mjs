/* bench_scale.mjs -- one-off benchmark used for the report in docs/18.
 * Not a test; it prints the numbers that go into the docs table.
 *
 * Usage: node tools/bench_scale.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { coreEntry, userEntry, makeWorld, waitForPlugins } from '../test/lib/bncm-harness.mjs';
import { startHost, readZip, readZipArchive, hostStats } from './ncm_host.mjs';

const range = (n) => Array.from({ length: n }, (_, i) => i);
const LAT = 25;
const rows = [];
for (const N of [10, 60, 200]) {
  for (const conc of [1, 6]) {
    if (N === 200 && conc === 1) continue;                 // 5 s of pure waiting; the 10/60 rows prove it
    const w = makeWorld({
      core: [coreEntry('Core')],
      plugins: range(N).map((i) => userEntry('P' + i)),
      latency: LAT, config: { concurrency: conc },
    });
    const t0 = Date.now();
    try { await waitForPlugins(w, N + 1, 30000); } catch { /* printed anyway */ }
    const wall = Date.now() - t0;
    const p = w.stats();
    rows.push({ N: N + 1, conc, wall, boot: Math.round(p.total_ms), inFlight: w.inflight.scriptMax,
                floor: (N + 1) * LAT, yields: p.yields });
    w.dispose();
  }
}
console.log('framework: N plugins, 25ms per script download');
console.log('plugins  concurrency  boot(ms)  max-in-flight  serial-floor(ms)  yields');
for (const r of rows) {
  console.log(String(r.N).padEnd(8), String(r.conc).padEnd(12), String(r.wall).padEnd(9),
              String(r.inFlight).padEnd(14), String(r.floor).padEnd(17), r.yields);
}

/* ---- host: same plugin set, cache vs no cache ---------------------------- */
function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const data = Buffer.from(body); const comp = deflateRawSync(data); const crc = crc32(data) >>> 0;
    const nb = Buffer.from(name, 'utf8');
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6);
    l.writeUInt16LE(8, 8); l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nb.length, 26);
    locals.push(l, nb, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nb); offset += l.length + nb.length + comp.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const mf = (slug) => JSON.stringify({ manifest_version: 1, name: slug, slug, version: '1.0.0',
  author: 'b', type: 'extension', 'ncm-version-req': '> 2.10.2', injects: { Main: [{ file: 'main.js' }] } });

const root = mkdtempSync(join(tmpdir(), 'bncm-bench-'));
const pluginsDir = join(root, 'plugins');
mkdirSync(pluginsDir, { recursive: true });
const N = 40;
for (let i = 0; i < N; i++) writeFileSync(join(pluginsDir, 'S' + i + '.plugin'), makeZip([
  ['manifest.json', mf('S' + i)], ['main.js', 'window.__x__=1;']]));
const heavy = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < heavy.length; i += 4) heavy.writeUInt32LE((i * 2654435761) >>> 0, i);
writeFileSync(join(pluginsDir, 'Heavy.plugin'), makeZip([
  ['manifest.json', mf('Heavy')], ['main.js', 'window.__h__=1;'], ['assets/blob.bin', heavy]]));

async function req(h, path) {
  const res = await fetch(h.api + path, { headers: { 'X-BNCM-Key': h.key } });
  return { status: res.status, text: await res.text() };
}
const perfOf = async (h) => JSON.parse((await req(h, '/api/perf')).text);

for (const [label, opts] of [['cache ON ', { discoveryTtlMs: 0 }], ['cache OFF', { discoveryCache: false }]]) {
  const h = await startHost(Object.assign({ quiet: true, port: 0, data: join(root, 'd-' + label.trim()),
    plugins: pluginsDir, corePlugins: null }, opts));
  try {
    await req(h, '/api/plugins');
    const before = await perfOf(h);
    const t0 = Date.now();
    for (let i = 0; i < 240; i++) await req(h, `/api/plugin/S${i % N}/main.js`);
    const ms = Date.now() - t0;
    const mid = await perfOf(h);
    // the pathological one: the archive that also holds 4 MB of assets
    for (let i = 0; i < 20; i++) await req(h, '/api/plugin/Heavy/main.js');
    const after = await perfOf(h);
    console.log(`${label}: 240 requests ${ms}ms (${(ms / 240).toFixed(2)}ms each), ` +
      `scans ${mid.discovery.calls - before.discovery.calls}, ` +
      `scan_ms ${(mid.discovery.ms_total - before.discovery.ms_total).toFixed(1)}, ` +
      `entries_inflated ${mid.zip.entries - before.zip.entries}, ` +
      `bytes_inflated ${mid.zip.bytes_inflated - before.zip.bytes_inflated}; ` +
      `20x Heavy/main.js -> +${after.zip.bytes_inflated - mid.zip.bytes_inflated} B inflated`);
  } finally { h.server.close(); }
}

/* eager vs lazy on the Heavy archive */
const buf = readFileSync(join(pluginsDir, 'Heavy.plugin'));
let m = hostStats.zip.bytes_inflated;
readZip(buf);
const eager = hostStats.zip.bytes_inflated - m;
m = hostStats.zip.bytes_inflated;
readZipArchive(buf).get('main.js');
const lazy = hostStats.zip.bytes_inflated - m;
console.log(`zip reader on Heavy.plugin (4.0 MB asset inside): eager ${eager} B, lazy(one entry) ${lazy} B`);

rmSync(root, { recursive: true, force: true });
process.exit(0);
