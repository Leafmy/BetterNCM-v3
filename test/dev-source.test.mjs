/* dev-source.test.mjs -- dev mode on the backend: plugin sources, change detection, dev hooks.
 *
 * Why this exists
 * ---------------
 * Dev mode is the answer to "how do I iterate on a plugin without packing and restarting", so it
 * has to be trustworthy in exactly the ways a normal session is NOT exercised:
 *
 *   - a source may be a directory, an archive, or a GitHub repo spec;
 *   - a source that clashes with an installed plugin must NOT silently shadow it;
 *   - a source that fails (bad path, unreachable URL) must stay visible as an error instead of
 *     disappearing or taking the host down;
 *   - change detection must actually bump the generation the page polls;
 *   - dev hijack rules must reach /api/hijacks, because that is the only channel the document-start
 *     preload reads.
 *
 * Nothing here needs the client, the network, or a GitHub token: the tarball path is exercised with
 * a synthetic codeload tarball, and the unreachable-URL case uses a closed loopback port.
 *
 * Run: node test/dev-source.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { startHost, parseDevSource, tarToPluginFiles } from '../tools/ncm_host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

/* --------------------------------------------------------------- fixtures ---- */

/** A minimal but valid BetterNCM plugin directory. */
function writePluginDir(dir, slug, version = '1.0.0', extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 1, name: slug, slug, version, author: 'dev', type: 'extension',
    'ncm-version-req': '> 2.10.2',
    injects: { Main: [{ file: 'main.js' }] },
    ...extra,
  }, null, 1), 'utf8');
  writeFileSync(join(dir, 'main.js'), 'window.__dev_plugin_ran__ = (window.__dev_plugin_ran__ || 0) + 1;\n', 'utf8');
  return dir;
}

/** A tar entry (ustar, no pax) -- enough for tarToPluginFiles, and independent of any tar lib. */
function tarEntry(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.write('        ', 148, 8);              // checksum field: spaces while summing
  header.write('0', 156, 1);                    // typeflag: regular file
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}
function tarGz(files) {
  const parts = Object.entries(files).map(([name, body]) => tarEntry(name, Buffer.from(body)));
  parts.push(Buffer.alloc(1024));               // end-of-archive
  return gzipSync(Buffer.concat(parts));
}

async function req(h, path, opts = {}) {
  const res = await fetch(h.api + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'X-BNCM-Key': h.key },
      opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/* ------------------------------------------------------------------ tests ---- */

async function main() {
  console.log('--- source specs ---');
  {
    const gh = parseDevSource('acme/music-plugin#v1.2.3:dist');
    eq('owner/repo#ref:subdir -> github', gh.type, 'github');
    eq('... repo is owner/name', gh.repo, 'acme/music-plugin');
    eq('... ref is parsed', gh.ref, 'v1.2.3');
    eq('... subdir is parsed', gh.subdir, 'dist');

    const url = parseDevSource('https://github.com/acme/music-plugin/tree/dev/plugins/foo');
    eq('github.com/tree URL -> ref', url.ref, 'dev');
    eq('github.com/tree URL -> subdir', url.subdir, 'plugins/foo');

    const zipUrl = parseDevSource('https://example.com/thing.plugin');
    eq('an archive URL is a URL source', zipUrl.type, 'url');
    eq('... and keeps the URL', zipUrl.url, 'https://example.com/thing.plugin');

    const bogus = (() => { try { parseDevSource('C:\\definitely\\not\\here\\nope'); return null; }
      catch (e) { return e; } })();
    ok('a missing local path is rejected up front, with the path in the message',
       !!bogus && bogus.message.includes('not\\here\\nope'), bogus && bogus.message);
  }

  console.log('\n--- codeload tarball ---');
  {
    const buf = tarGz({
      'music-plugin-abc123/manifest.json': JSON.stringify({ manifest_version: 1, slug: 'Outer' }),
      'music-plugin-abc123/dist/manifest.json': JSON.stringify({ manifest_version: 1, slug: 'Inner' }),
      'music-plugin-abc123/dist/main.js': 'window.ok = true;',
      'music-plugin-abc123/README.md': '# hi',
    });
    const root = tarToPluginFiles(buf, null);
    ok('top-level directory is stripped', root.has('manifest.json') && root.has('README.md'));
    ok('nested files keep their sub-path', root.has('dist/main.js'));

    const dist = tarToPluginFiles(buf, 'dist');
    ok('subdir selection keeps only that subtree', dist.has('manifest.json') && dist.has('main.js'));
    ok('... and drops the rest', !dist.has('README.md') && !dist.has('dist/main.js'));

    // A pax header (or any root-level entry) can precede the tree; the prefix must still be found.
    const withPax = tarGz({
      pax_global_header: 'x',
      'music-plugin-abc123/dist/main.js': 'window.ok = true;',
    });
    const stripped = tarToPluginFiles(withPax, null);
    ok('a root-level entry before the tree does not break the prefix strip',
       stripped.has('dist/main.js') && !stripped.has('pax_global_header'));
  }

  console.log('\n--- host integration ---');
  const root = mkdtempSync(join(tmpdir(), 'bncm-dev-'));
  const dataDir = join(root, 'data');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const devDir = writePluginDir(join(root, 'src', 'DevPlugin'), 'DevPlugin');

  let h = await startHost({
    quiet: true, port: 0, data: dataDir, plugins: pluginsDir, corePlugins: null,
    devSources: [devDir],
  });

  try {
    const st = await req(h, '/api/dev/status');
    eq('status is served', st.status, 200);
    eq('dev mode is enabled by a CLI source', st.data.enabled, true);
    eq('the source is listed once', st.data.sources.length, 1);
    eq('the source is recognised as a directory', st.data.sources[0].type, 'dir');
    eq('the source resolves to a plugin slug', st.data.sources[0].plugin && st.data.sources[0].plugin.slug, 'DevPlugin');
    eq('the dev plugin is reported in status.plugins', st.data.plugins[0] && st.data.plugins[0].slug, 'DevPlugin');

    const pl = await req(h, '/api/plugins');
    const devEntries = pl.data.plugins.filter((p) => p.dev === true);
    eq('a dev plugin appears in /api/plugins', devEntries.length, 1);
    eq('... as an ordinary (non-core, unlocked) user plugin', devEntries[0].core, false);
    eq('... with its manifest loaded', devEntries[0].manifest.slug, 'DevPlugin');

    const state = await req(h, '/api/state');
    ok('the manager snapshot marks it dev', state.data.plugins.some((p) => p.dev === true && p.slug === 'DevPlugin'));

    // --- change detection ----------------------------------------------------
    const js = join(devDir, 'main.js');
    writeFileSync(js, readFileSync(js, 'utf8') + '// edit\n', 'utf8');
    const future = new Date(Date.now() + 4000);
    utimesSync(js, future, future);
    const changed = await h.dev.rescan();
    ok('an edited source is detected and returned as changed', changed.includes(st.data.sources[0].id));
    const st2 = await req(h, '/api/dev/status');
    eq('... and the generation moved', st2.data.generation, 1);
    eq('... recording what changed', st2.data.last_change && st2.data.last_change.sources.length, 1);

    const reload = await req(h, '/api/dev/reload', { method: 'POST', body: {} });
    eq('an explicit reload always bumps the generation', reload.data.generation, 2);

    // `dist/` is where most plugins keep their built bundle, so it must NOT be treated as noise.
    mkdirSync(join(devDir, 'dist'), { recursive: true });
    const bundle = join(devDir, 'dist', 'bundle.js');
    writeFileSync(bundle, 'window.__bundle__ = 1;\n', 'utf8');
    const future2 = new Date(Date.now() + 8000);
    utimesSync(bundle, future2, future2);
    const changed2 = await h.dev.rescan();
    ok('a rebuild into dist/ is detected too', changed2.includes(st.data.sources[0].id));
    eq('... bumping the generation again', (await req(h, '/api/dev/status')).data.generation, 3);

    // --- watch ---------------------------------------------------------------
    const watchOn = await req(h, '/api/dev/watch', { method: 'POST', body: { enabled: true, interval_ms: 700 } });
    eq('watch can be switched on', watchOn.data.watching, true);
    eq('... with the requested interval', watchOn.data.interval_ms, 700);
    const watchOff = await req(h, '/api/dev/watch', { method: 'POST', body: { enabled: false } });
    eq('watch can be switched off', watchOff.data.watching, false);

    // --- dev hijack rules reach the preload ---------------------------------
    const before = await req(h, '/api/hijacks');
    ok('no dev rule before adding one', !before.data.rules.some((r) => r.origin === 'dev'));
    await req(h, '/api/dev/hooks/add', {
      method: 'POST',
      body: { rule: { id: 'probe', type: 'replace', from: 'SOURCE_FRAGMENT', to: 'REPLACED', url: 'builtin:lyrics-pipeline' } },
    });
    const after = await req(h, '/api/hijacks');
    const devRule = after.data.rules.find((r) => r.id === 'dev:probe');
    ok('a dev rule is published to /api/hijacks', !!devRule);
    eq('... with its from/to', devRule.from + '->' + devRule.to, 'SOURCE_FRAGMENT->REPLACED');
    eq('... marked as a dev origin', devRule.origin, 'dev');
    eq('... and actionable (not pending)', devRule.pending, false);

    await req(h, '/api/dev/hooks/add', {
      method: 'POST',
      body: { rule: { id: 'adopt', rule: 'builtin:lyrics-hook' } },
    });
    const delegated = (await req(h, '/api/hijacks')).data.rules.find((r) => r.id === 'dev:adopt');
    ok('a dev rule may delegate to a builtin rule', !!delegated && delegated.rule === 'builtin:lyrics-hook');

    await req(h, '/api/dev/hooks/clear', { method: 'POST', body: {} });
    ok('dev rules can be cleared', !(await req(h, '/api/hijacks')).data.rules.some((r) => r.origin === 'dev'));
    ok('clearing dev rules does not touch builtin rules',
       (await req(h, '/api/hijacks')).data.rules.some((r) => r.origin === 'builtin'));

    // --- a packed archive as a source ---------------------------------------
    const selftest = join(REPO, 'plugins', 'bncm-selftest.plugin');
    if (existsSync(selftest)) {
      const added = await req(h, '/api/dev/sources/add', { method: 'POST', body: { source: selftest } });
      eq('a .plugin archive can be a dev source', added.status, 200);
      ok('... and its manifest is resolved', !!added.data.source.plugin, JSON.stringify(added.data.source));
      eq('... sources now number two', (await req(h, '/api/dev/status')).data.sources.length, 2);
    }

    // --- a source may not shadow an installed plugin ------------------------
    const clash = writePluginDir(join(root, 'src', 'DevPluginCopy'), 'DevPlugin');
    await req(h, '/api/dev/sources/add', { method: 'POST', body: { source: clash } });
    const clashList = await req(h, '/api/plugins');
    eq('a duplicate dev slug is loaded once, not twice',
       clashList.data.plugins.filter((p) => p.manifest && p.manifest.slug === 'DevPlugin').length, 1);

    // --- a bad source stays visible instead of taking the host down ---------
    const bad = await req(h, '/api/dev/sources/add', { method: 'POST', body: { source: 'https://127.0.0.1:1/nope.plugin' } });
    eq('an unreachable remote source is accepted (and reported)', bad.status, 200);
    ok('... with an error recorded', !!(await req(h, '/api/dev/status')).data.sources.find((s) => s.input.includes('127.0.0.1:1')).error);
    const afterBad = await req(h, '/api/plugins');
    const badEntry = afterBad.data.plugins.find((p) => String(p.dir).includes('127.0.0.1:1'));
    ok('... surfaced as an error entry rather than a loadable plugin',
       !!badEntry && badEntry.manifest === null && !!badEntry.error,
       JSON.stringify(badEntry || null));

    // --- a remote archive: fetched, fingerprinted, and re-detected on change --
    {
      const zipA = readFileSync(join(REPO, 'plugins', 'bncm-selftest.plugin'));
      const zipB = readFileSync(join(REPO, 'plugins', 'incompatible-plugin.plugin'));
      let payload = zipA;
      const srv = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': payload.length });
        res.end(payload);
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      try {
        const remoteUrl = `http://127.0.0.1:${srv.address().port}/thing.plugin`;
        const added = await req(h, '/api/dev/sources/add', { method: 'POST', body: { source: remoteUrl } });
        eq('a remote archive URL becomes a dev source', added.status, 200);
        eq('... typed as a URL source', added.data.source.type, 'url');
        ok('... resolved to a real plugin manifest', !!added.data.source.plugin, JSON.stringify(added.data.source.error));
        ok('... and fingerprinted for change detection', !!added.data.source.fingerprint);

        payload = zipB;                                   // the "release" changes upstream
        const rel = await req(h, '/api/dev/reload', { method: 'POST', body: {} });
        ok('a changed remote payload is detected as a change',
           rel.data.changed.includes(added.data.source.id), JSON.stringify(rel.data.changed));
      } finally {
        await new Promise((r) => srv.close(r));
      }
    }

    // --- removal -------------------------------------------------------------
    const statusNow = (await req(h, '/api/dev/status')).data;
    const target = statusNow.sources.find((s) => s.type === 'zip' && !s.error) || statusNow.sources[0];
    const removed = await req(h, '/api/dev/sources/remove', { method: 'POST', body: { id: target.id } });
    eq('a source can be removed', removed.status, 200);
    eq('... and the list shrinks', removed.data.sources.length, statusNow.sources.length - 1);
    eq('an unknown source id is a 404', (await req(h, '/api/dev/sources/remove', { method: 'POST', body: { id: 'nope' } })).status, 404);

    // --- persistence across a host restart ----------------------------------
    await new Promise((r) => h.server.close(r));
    h = await startHost({ quiet: true, port: 0, data: dataDir, plugins: pluginsDir, corePlugins: null });
    const persisted = await req(h, '/api/dev/status');
    ok('sources added during the session survive a host restart', persisted.data.sources.length >= 1);
    ok('... and still load as plugins',
       (await req(h, '/api/plugins')).data.plugins.some((p) => p.dev === true));
    ok('dev state files land in the data directory', existsSync(join(dataDir, 'dev_sources.json')));
  } finally {
    await new Promise((r) => h.server.close(r));
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
