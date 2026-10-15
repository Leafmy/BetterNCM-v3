/* host-scale.test.mjs -- does the backend stay cheap as plugins are ADDED?
 *
 * The page asks the host for one file per plugin script.  The old backend answered each of those
 * requests by re-walking the plugins directory and re-reading + re-inflating every `.plugin`
 * archive -- including the ones it was not asked about -- and re-parsing the same manifests.  With
 * four plugins nobody notices; with forty, request cost scales with the size of the whole plugin
 * set, which is exactly the "it got laggy as I installed more plugins" report.
 *
 * This suite builds a real plugin set on disk and checks the properties that make the cost
 * independent of how many plugins exist:
 *
 *   1. archive entries are inflated LAZILY -- serving a small script out of an archive that also
 *      contains megabytes of assets must not inflate the assets;
 *   2. repeated file requests reuse the discovery scan instead of re-reading archives;
 *   3. the cache is not a lie: installing or uninstalling a plugin is still picked up;
 *   4. responses carry a validator, so a re-injected page pays 304s for scripts it already has;
 *   5. page log lines can be batched into one request;
 *   6. the counters that prove all of this are available at /api/perf.
 *
 * Run: node test/host-scale.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { startHost, readZip, readZipArchive, hostStats } from '../tools/ncm_host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

/* ------------------------------------------------------- zip writer ---- */
/** A real (deflate) zip archive: enough for the reader, and it lets the test measure inflation. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const data = Buffer.from(body);
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function manifestFor(slug, extra = {}) {
  return JSON.stringify(Object.assign({
    manifest_version: 1, name: slug, slug, version: '1.0.0', author: 'scale',
    type: 'extension', 'ncm-version-req': '> 2.10.2',
    injects: { Main: [{ file: 'main.js' }] },
  }, extra), null, 1);
}

/** Write `count` tiny plugins, plus ONE archive with a multi-megabyte asset next to a small script. */
function writePluginSet(dir, count, bigArchiveSlug = 'Heavy') {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const slug = 'Scale' + i;
    const zip = makeZip([
      ['manifest.json', manifestFor(slug)],
      ['main.js', `window.__scale_ran__=(window.__scale_ran__||0)+1; // ${slug}\n`],
    ]);
    writeFileSync(join(dir, slug + '.plugin'), zip);
  }
  // ~4 MB of incompressible asset data in the same archive as a 100-byte script.
  const heavy = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < heavy.length; i += 4) heavy.writeUInt32LE((i * 2654435761) >>> 0, i);
  writeFileSync(join(dir, bigArchiveSlug + '.plugin'), makeZip([
    ['manifest.json', manifestFor(bigArchiveSlug)],
    ['main.js', 'window.__heavy_ran__=1;\n'],
    ['assets/blob.bin', heavy],
  ]));
  return heavy.length;
}

async function req(h, path, opts = {}) {
  const res = await fetch(h.api + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'X-BNCM-Key': h.key },
      opts.body === undefined ? {} : { 'Content-Type': 'application/json' },
      opts.headers || {}),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

const perf = (h) => req(h, '/api/perf').then((r) => r.data);

async function main() {
  console.log('host scale');
  const root = mkdtempSync(join(tmpdir(), 'bncm-scale-'));
  const dataDir = join(root, 'data');
  const pluginsDir = join(root, 'plugins');
  const N = 40;
  const heavyBytes = writePluginSet(pluginsDir, N);
  let h = null;

  try {
    /* ---- 0. the cost being removed, measured on the same archive -------- */
    {
      const buf = readFileSync(join(pluginsDir, 'Heavy.plugin'));
      // Eager reader (what the host used to call for every request): every entry, every time.
      let mark = hostStats.zip.bytes_inflated;
      const eager = readZip(buf);
      const eagerBytes = hostStats.zip.bytes_inflated - mark;
      // Lazy reader: only the entry that was asked for.
      mark = hostStats.zip.bytes_inflated;
      const archive = readZipArchive(buf);
      const script = archive.get('main.js');
      const lazyBytes = hostStats.zip.bytes_inflated - mark;
      console.log(`       eager read inflates ${eagerBytes} B of this archive; ` +
                  `asking for main.js alone inflates ${lazyBytes} B`);
      eq('both readers see the same entries', eager.size, archive.size);
      ok(`eager reading pays for the whole archive (${eagerBytes} B >= ${heavyBytes} B)`,
         eagerBytes >= heavyBytes, `eager=${eagerBytes}`);
      ok(`lazy reading pays for one entry only (${lazyBytes} B < 64 KB)`, lazyBytes < 64 * 1024,
         `lazy=${lazyBytes}`);
      ok('... and returns the right bytes', String(script).indexOf('__heavy_ran__') !== -1);
    }

    h = await startHost({
      quiet: true, port: 0, data: dataDir, plugins: pluginsDir, corePlugins: null,
      // ttl 0 = revalidate by directory signature on every discovery.  That is the strictest
      // correctness setting (installs are visible immediately) and still never reads an archive.
      discoveryTtlMs: 0,
    });

    /* ---- 1. lazy archive inflation -------------------------------------- */
    {
      const before = await perf(h);
      const r = await req(h, '/api/plugin/Heavy/main.js');
      const after = await perf(h);
      const inflated = after.zip.bytes_inflated - before.zip.bytes_inflated;
      console.log(`       Heavy.plugin holds ${(heavyBytes / 1048576).toFixed(1)} MB of assets; ` +
                  `serving main.js inflated ${inflated} B`);
      eq('the small script is served', r.status, 200);
      ok('it is the script, not the manifest', String(r.data).indexOf('__heavy_ran__') !== -1);
      ok(`only the requested entry is inflated (${inflated} B, not ${heavyBytes} B)`,
         inflated > 0 && inflated < 64 * 1024,
         `inflated ${inflated}`);
    }

    /* ---- 2. request cost does not grow with the plugin count ------------- */
    {
      await req(h, '/api/plugins');
      const before = await perf(h);
      const slugs = Array.from({ length: N }, (_, i) => 'Scale' + i);
      let bad = 0;
      const t0 = Date.now();
      for (let i = 0; i < 240; i++) {
        const r = await req(h, `/api/plugin/${slugs[i % N]}/main.js`);
        if (r.status !== 200 || String(r.data).indexOf('__scale_ran__') === -1) bad++;
      }
      const ms = Date.now() - t0;
      const after = await perf(h);
      const calls = after.discovery.calls - before.discovery.calls;
      const hits = after.discovery.cache_hits - before.discovery.cache_hits;
      const zipReads = after.zip.entries - before.zip.entries;
      console.log(`       240 script requests over ${N} plugins in ${ms}ms ` +
                  `(${(ms / 240).toFixed(2)}ms each): discovery re-scans ${calls}, ` +
                  `cache hits ${hits}, archive entries inflated ${zipReads}`);
      eq('all 240 scripts served correctly', bad, 0);
      ok(`no re-scan per request (${calls} scans for 240 requests)`, calls <= 8, `scans=${calls}`);
      ok(`the cache answers the burst (${hits} hits)`, hits >= 200, `hits=${hits}`);
      ok(`each archive entry is inflated at most once (${zipReads} entries)`, zipReads <= N + 4,
         `entries=${zipReads}`);
      ok(`requests stay cheap (${(ms / 240).toFixed(2)}ms each)`, ms / 240 < 25);
    }

    /* ---- 3. the cache is not stale: install / uninstall are visible ------ */
    {
      const slug = 'LateArrival';
      writeFileSync(join(pluginsDir, slug + '.plugin'), makeZip([
        ['manifest.json', manifestFor(slug)],
        ['main.js', 'window.__late__=1;\n'],
      ]));
      const list = (await req(h, '/api/plugins')).data;
      ok('a plugin installed after startup is discovered',
         list.plugins.some((p) => p.manifest && p.manifest.slug === slug));
      const r = await req(h, `/api/plugin/${slug}/main.js`);
      eq('... and its script is servable', r.status, 200);

      const moved = join(root, 'gone.plugin');
      const { renameSync } = await import('node:fs');
      renameSync(join(pluginsDir, slug + '.plugin'), moved);
      const list2 = (await req(h, '/api/plugins')).data;
      ok('an uninstalled plugin disappears',
         !list2.plugins.some((p) => p.manifest && p.manifest.slug === slug));
      eq('... and its script is no longer served', (await req(h, `/api/plugin/${slug}/main.js`)).status, 404);
    }

    /* ---- 3b. an EDITED plugin is served with new bytes, not cached ones --- */
    {
      // An archive replaced at the same path, with different content and a different size (so the
      // directory signature cannot be defeated by filesystem timestamp granularity).
      const slug = 'Scale5';
      writeFileSync(join(pluginsDir, slug + '.plugin'), makeZip([
        ['manifest.json', manifestFor(slug)],
        ['main.js', 'window.__replaced_v2__=(window.__replaced_v2__||0)+1; // longer body\n'],
      ]));
      const r = await req(h, `/api/plugin/${slug}/main.js`);
      ok('a replaced archive is re-read, not served from cache',
         String(r.data).indexOf('__replaced_v2__') !== -1, String(r.data).slice(0, 80));

      // An unpacked plugin edited in place: a directory's own mtime does not change when a file
      // inside it is rewritten, which is exactly how this can go stale.
      const dir = join(pluginsDir, 'SrcPlugin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), manifestFor('SrcPlugin'));
      writeFileSync(join(dir, 'main.js'), 'window.__dir_v1__=1;\n');
      const r1 = await req(h, '/api/plugin/SrcPlugin/main.js');
      ok('an unpacked plugin is served', String(r1.data).indexOf('__dir_v1__') !== -1);
      writeFileSync(join(dir, 'main.js'), 'window.__dir_v2__=1;\n');
      const r2 = await req(h, '/api/plugin/SrcPlugin/main.js');
      ok('an unpacked plugin edited in place is re-read (no stale cache)',
         String(r2.data).indexOf('__dir_v2__') !== -1, String(r2.data).slice(0, 80));
    }

    /* ---- 4. validators: a re-injected page revalidates instead of re-downloading ---- */
    {
      const first = await req(h, '/api/plugin/Scale3/main.js');
      const etag = first.headers.get('etag');
      ok('plugin scripts carry an ETag', !!etag, String(etag));
      eq('... with a revalidation cache policy', first.headers.get('cache-control'), 'no-cache');
      const before = await perf(h);
      const second = await req(h, '/api/plugin/Scale3/main.js',
                               { headers: { 'If-None-Match': etag } });
      const after = await perf(h);
      eq('an unchanged script answers 304', second.status, 304);
      ok('... and is counted as a 304, not a full serve',
         after.files.not_modified > before.files.not_modified);
      const framework = await req(h, '/framework.js');
      ok('framework.js gets validators too', !!framework.headers.get('etag'));
    }

    /* ---- 5. batched page logging ---------------------------------------- */
    {
      const before = await perf(h);
      const messages = Array.from({ length: 50 }, (_, i) => 'batch line ' + i);
      const r = await req(h, '/api/log', { method: 'POST', body: { messages } });
      await new Promise((res) => setTimeout(res, 260));       // let the log buffer flush
      eq('a batch is accepted', r.data.lines, 50);
      const after = await perf(h);
      ok('all 50 lines reached the host log', after.log.lines - before.log.lines >= 50);
      eq('... in a single flush', after.log.flushes - before.log.flushes, 1);
    }

    /* ---- 6. /api/perf is a real, keyed endpoint ------------------------- */
    {
      const noKey = await fetch(h.api + '/api/perf');
      eq('counters are not exposed without the API key', noKey.status, 403);
      const p = await perf(h);
      ok('counters report requests', typeof p.requests === 'number' && p.requests > 250);
      ok('counters report the discovery cache size', p.discovery.cache_entries >= 1);
    }

    /* ---- 7. a TTL actually batches a boot burst ------------------------- */
    {
      const h2 = await startHost({
        quiet: true, port: 0, data: join(root, 'data2'), plugins: pluginsDir, corePlugins: null,
        discoveryTtlMs: 5000,
      });
      try {
        await req(h2, '/api/plugins');
        const before = await perf(h2);
        for (let i = 0; i < 60; i++) await req(h2, `/api/plugin/Scale${i % N}/main.js`);
        const after = await perf(h2);
        const calls = after.discovery.calls - before.discovery.calls;
        console.log(`       TTL=5000ms: 60 boot-burst requests -> ${calls} discovery scan(s)`);
        ok(`a boot burst does not re-scan per request (${calls} scans)`, calls <= 2, `scans=${calls}`);
      } finally {
        h2.server.close();
      }
    }

    /* ---- 8. discovery stays correct with the default TTL too ------------ */
    {
      const h3 = await startHost({
        quiet: true, port: 0, data: join(root, 'data3'), plugins: pluginsDir, corePlugins: null,
      });
      try {
        const stamp = new Date(Date.now() + 60000);
        const f = join(pluginsDir, 'Scale0.plugin');
        utimesSync(f, stamp, stamp);              // mtime moves well past any TTL
        const r = await req(h3, '/api/perf');
        ok('a different host instance still starts with a working cache',
           r.status === 200 && r.data.discovery.cache_entries >= 1);
        eq('and it serves the plugin normally', (await req(h3, '/api/plugin/Scale0/main.js')).status, 200);
      } finally {
        h3.server.close();
      }
    }

    /* ---- 9. the switch that restores the old behaviour, for comparison -- */
    {
      const h4 = await startHost({
        quiet: true, port: 0, data: join(root, 'data4'), plugins: pluginsDir, corePlugins: null,
        discoveryCache: false,
      });
      try {
        const before = await perf(h4);
        for (let i = 0; i < 60; i++) await req(h4, `/api/plugin/Scale${i % N}/main.js`);
        const after = await perf(h4);
        const calls = after.discovery.calls - before.discovery.calls;
        console.log(`       --no-discovery-cache: 60 requests -> ${calls} archive-directory scans ` +
                    `(the behaviour the cache replaces)`);
        ok(`without the cache every request re-scans (${calls} scans)`, calls >= 60, `scans=${calls}`);
      } finally {
        h4.server.close();
      }
    }

    /* ---- 10. ordering metadata survives normalisation -------------------- *
     *
     * The page-side loader sorts plugins by `manifest.loadAfter` / `manifest.requirements`, and it
     * reads those fields from THIS endpoint's response -- never from the raw manifest.json inside
     * the archive.  normaliseManifest() used to rebuild the manifest from a fixed list of keys and
     * silently dropped both, so the documented chain
     *
     *     MaterialYouTheme  <-(loadAfter)  RefinedNowPlaying  <-(requirements/loadAfter)  LyricBar
     *
     * degraded to alphabetical order and LyricBar could be evaluated before the plugin it requires.
     * loader-scale.test.mjs could not see this: its harness fabricates the /api/plugins payload, so
     * the fields were always there.  This is the end-to-end version, through the real archive ->
     * scanPlugins -> normaliseManifest -> HTTP path.
     */
    {
      writeFileSync(join(pluginsDir, 'Base.plugin'), makeZip([
        ['manifest.json', manifestFor('Base')],
        ['main.js', 'window.__base__=1;\n'],
      ]));
      writeFileSync(join(pluginsDir, 'Dep.plugin'), makeZip([
        ['manifest.json', manifestFor('Dep', {
          loadAfter: ['Base'], requirements: ['Base'], incompatible: ['Some-Other-Plugin'],
        })],
        ['main.js', 'window.__dep__=1;\n'],
      ]));
      const list = (await req(h, '/api/plugins')).data;
      const dep = list.plugins.find((p) => p.manifest && p.manifest.slug === 'Dep');
      const base = list.plugins.find((p) => p.manifest && p.manifest.slug === 'Base');
      ok('the dependent plugin is discovered', !!dep);
      eq('loadAfter survives normalisation',
         JSON.stringify(dep && dep.manifest.loadAfter), JSON.stringify(['Base']));
      eq('requirements survives normalisation',
         JSON.stringify(dep && dep.manifest.requirements), JSON.stringify(['Base']));
      eq('incompatible survives normalisation',
         JSON.stringify(dep && dep.manifest.incompatible), JSON.stringify(['Some-Other-Plugin']));
      eq('a plugin without ordering metadata gets empty lists, not undefined',
         JSON.stringify(base && [base.manifest.loadAfter, base.manifest.requirements]),
         JSON.stringify([[], []]));
      console.log('       Dep.loadAfter=' + JSON.stringify(dep && dep.manifest.loadAfter) +
                  ' Dep.requirements=' + JSON.stringify(dep && dep.manifest.requirements));
    }

  } finally {
    if (h) h.server.close();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
