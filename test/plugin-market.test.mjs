/* plugin-market.test.mjs -- the bundled plugin market, end to end and without a client.
 *
 * The market is the one feature whose failure mode is destructive: it writes executable plugin
 * archives into the directory the client loads from.  So the properties this suite pins down are
 * the ones that decide whether a bad mirror, a hostile index or a half-finished download can cost
 * the user a working plugin:
 *
 *   1. the BUILT-IN source works with no network -- the four plugins this build ships are always
 *      listed, resolvable and installable;
 *   2. market/ is DERIVED from the plugin archives: the index's slug/version/sha256/size must
 *      match what the package actually contains, or the listing is a lie;
 *   3. an install is verified BEFORE it lands: zip parses, root manifest readable, slug matches,
 *      sha256 matches.  Every failure leaves the plugin directory byte-identical;
 *   4. requirements are installed first, a missing requirement aborts the whole install, and a
 *      dependency cycle is an error rather than a hang;
 *   5. `loadAfter` is REPORTED (recommended), never installed silently;
 *   6. updating replaces the old archive reversibly, and themes stay mutually exclusive;
 *   7. a source that is down degrades to its cache and never takes the built-in source with it;
 *   8. uninstalling goes through the reversible host move, not a delete.
 *
 * Run: node test/plugin-market.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { startHost } from '../tools/ncm_host.mjs';
import {
  DEFAULT_SOURCES, BUILTIN_SOURCE_ID, compareVersions, normaliseVersion,
  safePackageName, readManifestFromZip, sha256,
} from '../tools/market_host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MARKET = join(REPO, 'market');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

/* ------------------------------------------------------------- zip writer ---- */
/** A real deflate archive, so the host's lazy reader and the market's verifier both accept it. */
function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const data = Buffer.from(body);
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
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

function makePackage(slug, extra = {}, injectFile = 'main.js') {
  const manifest = Object.assign({
    manifest_version: 1, name: slug, slug, version: '1.0.0', author: 'market-test',
    description: slug + ' test package', type: 'extension', 'ncm3-compatible': true,
    injects: { Main: [{ file: injectFile }] },
  }, extra);
  return makeZip([
    ['manifest.json', JSON.stringify(manifest, null, 1)],
    [injectFile, `/* ${slug} */\n`],
  ]);
}

function makeEntry(slug, buf, extra = {}) {
  const manifest = readManifestFromZip(buf);
  return Object.assign({
    name: manifest.name, slug, version: manifest.version, author: manifest.author,
    description: manifest.description, type: manifest.type,
    'ncm3-compatible': manifest['ncm3-compatible'] === true,
    file: `${slug}-${manifest.version}.plugin`,
    'file-url': `plugins/${slug}-${manifest.version}.plugin`,
    preview: null, update_time: 100, publish_time: 200,
    sha256: sha256(buf), size: buf.length,
    requirements: manifest.requirements || [], loadAfter: manifest.loadAfter || [],
  }, extra);
}

/* --------------------------------------------------------- fake remote source ---- */
async function startFakeSource({ index, files }) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/plugins.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(index));
    }
    const rel = u.pathname.replace(/^\//, '');
    if (files[rel]) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(files[rel]);
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/* ------------------------------------------------------------------- host ---- */
const BUILTIN = DEFAULT_SOURCES.find((s) => s.id === BUILTIN_SOURCE_ID);

async function makeHost({ extraSources = [], ...opts } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bncm-market-'));
  const data = join(root, 'data');
  const plugins = join(root, 'plugins');
  mkdirSync(data, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  const sources = [{ ...BUILTIN, enabled: true }, ...extraSources];
  const h = await startHost({
    data, plugins, marketDir: MARKET, port: 0, key: 'testkey', quiet: true,
    marketSources: sources, ...opts,
  });
  const api = (p, o) => fetch(`http://127.0.0.1:${h.port}${p}`, {
    ...o,
    headers: { 'Content-Type': 'application/json', 'X-BNCM-Key': 'testkey' },
  });
  return {
    h, data, plugins, api,
    close: () => new Promise((done) => h.server.close(done)),
  };
}

/* ============================================================== 1. the source === */
console.log('\n== 1. market/ is derived from the plugin archives ==');
{
  const index = JSON.parse(readFileSync(join(MARKET, 'plugins.json'), 'utf8'));
  ok('market/plugins.json is a top-level array (upstream contract)', Array.isArray(index));
  eq('the built-in source lists four plugins', index.length, 4);

  const wanted = ['LyricBar', 'MaterialYouTheme', 'RefinedNowPlaying', 'NCM-Font-Manager'];
  wanted.forEach((slug) => {
    ok(`index lists ${slug}`, index.some((p) => p.slug === slug));
  });

  let mismatches = 0, missingPreview = 0, missingPackage = 0, digestBad = 0;
  for (const entry of index) {
    const pkg = join(MARKET, entry['file-url'].replace(/\//g, '/'));
    if (!existsSync(pkg)) { missingPackage++; continue; }
    const buf = readFileSync(pkg);
    const manifest = readManifestFromZip(buf);
    if (manifest.slug !== entry.slug) mismatches++;
    if (manifest.version !== entry.version) mismatches++;
    if (sha256(buf) !== entry.sha256) digestBad++;
    if (buf.length !== entry.size) digestBad++;
    const preview = join(MARKET, entry.preview);
    if (!existsSync(preview)) missingPreview++;
    if (!String(entry['file-url']).startsWith('plugins/')) mismatches++;
  }
  eq('every listed package is present', missingPackage, 0);
  eq('every listing agrees with its package manifest', mismatches, 0);
  eq('every listed sha256/size matches the bytes on disk', digestBad, 0);
  eq('every listing has its preview image', missingPreview, 0);

  const threeUpstreams = index.filter((p) => p.bundled);
  eq('all four are marked bundled', threeUpstreams.length, 4);
  ok('refined-now-playing records its upstream incompatibility',
    index.find((p) => p.slug === 'RefinedNowPlaying').incompatible.includes('Apple-Musiclike-lyrics'));
  ok('LyricBar declares RefinedNowPlaying as a requirement',
    index.find((p) => p.slug === 'LyricBar').requirements.includes('RefinedNowPlaying'));
}

/* ============================================================ 2. pure helpers === */
console.log('\n== 2. version and filename handling ==');
{
  eq('v-prefix is not a version difference', compareVersions('v1.0.4', '1.0.4'), 0);
  eq('1.0.10 > 1.0.9', compareVersions('1.0.10', '1.0.9'), 1);
  eq('3.0.2 < 3.1.0', compareVersions('3.0.2', '3.1.0'), -1);
  eq('normaliseVersion strips v', normaliseVersion('v2.19.5'), '2.19.5');

  let rejected = 0;
  for (const bad of ['../../evil.plugin', 'a/b.plugin', '..\\evil.plugin', '.hidden.plugin', 'x.exe']) {
    try { safePackageName(bad, 'slug'); } catch { rejected++; }
  }
  eq('hostile archive names are refused', rejected, 5);
  eq('a normal name passes through', safePackageName('LyricBar-0.3.6.plugin', 'LyricBar'), 'LyricBar-0.3.6.plugin');

  let notZip = false;
  try { readManifestFromZip(Buffer.from('this is not a zip archive at all')); } catch { notZip = true; }
  ok('a non-zip archive is rejected before it can be written', notZip);
}

/* ========================================================= 3. built-in install === */
console.log('\n== 3. offline install from the built-in source ==');
const main = await makeHost({ offline: true });
{
  const idx = await (await main.api('/api/market/plugins')).json();
  eq('built-in source is enabled and healthy', idx.sources.find((s) => s.builtin).ok, true);
  eq('index carries all four bundled plugins', idx.plugins.length, 4);
  ok('bundled plugins are flagged as such', idx.plugins.every((p) => p.bundled === true));
  ok('nothing is installed yet', idx.plugins.every((p) => p.installed === false));

  const install = await (await main.api('/api/market/install', {
    method: 'POST', body: JSON.stringify({ slug: 'LyricBar' }),
  })).json();
  ok('install succeeds offline', install.ok === true, JSON.stringify(install));
  eq('the requirement is installed too', install.installed.length, 2);
  ok('requirements are written before the plugin that needs them',
    install.installed[0].slug === 'RefinedNowPlaying' && install.installed[1].slug === 'LyricBar');
  ok('the sha256 from the index was verified', install.installed.every((x) => x.verified === true));
  ok('loadAfter is reported as a recommendation, not installed',
    install.recommended.length === 1 && install.recommended[0].slug === 'MaterialYouTheme');
  eq('a reload is requested', install.restart_required, true);

  const onDisk = readdirSync(main.plugins).sort();
  eq('exactly the two archives landed', onDisk.length, 2);
  ok('the archives are named after the index', onDisk.includes('LyricBar-0.3.6.plugin'));

  const listed = await (await main.api('/api/plugins')).json();
  const slugs = listed.plugins.map((p) => p.manifest && p.manifest.slug).sort();
  ok('the host discovers both installed plugins', slugs.includes('LyricBar') && slugs.includes('RefinedNowPlaying'));

  const idx2 = await (await main.api('/api/market/plugins')).json();
  const lyric = idx2.plugins.find((p) => p.slug === 'LyricBar');
  eq('the index now reports it as installed', lyric.installed, true);
  eq('and knows the installed version', lyric.installed_version, '0.3.6');
  eq('with no update pending', lyric.update_available, false);

  const again = await (await main.api('/api/market/install', {
    method: 'POST', body: JSON.stringify({ slug: 'LyricBar' }),
  })).json();
  eq('re-installing the same version is a no-op', again.installed.length, 0);
  eq('and says why', again.skipped[0].reason, '已安装同版本');

  const theme = await (await main.api('/api/market/install', {
    method: 'POST', body: JSON.stringify({ slug: 'MaterialYouTheme' }),
  })).json();
  ok('a bundled theme installs as well', theme.ok === true);

  const preview = await main.api('/api/market/preview?slug=LyricBar');
  eq('preview images come through the host', preview.status, 200);
  eq('with an image content type', preview.headers.get('content-type'), 'image/svg+xml');

  const missing = await (await main.api('/api/market/install', {
    method: 'POST', body: JSON.stringify({ slug: 'NoSuchPlugin' }),
  })).json();
  eq('an unknown slug is refused', missing.ok, false);
  ok('and the message names the plugin, not a "dependency"', /NoSuchPlugin/.test(missing.error), missing.error);
}

/* ================================================== 4. verification is a gate === */
console.log('\n== 4. a bad package is refused and nothing is replaced ==');
{
  const good = makePackage('GoodOne');
  const badDigestPkg = makePackage('BadDigest');
  const traversalPkg = makePackage('Traversal');
  const brokenBytes = Buffer.from('PK\x03\x04 not really a zip');
  const files = {
    'plugins/GoodOne-1.0.0.plugin': good,
    'plugins/Liar-1.0.0.plugin': good,                 // bytes belong to GoodOne, index says Liar
    'plugins/BadDigest-1.0.0.plugin': badDigestPkg,
    'plugins/Traversal-1.0.0.plugin': traversalPkg,
    'plugins/Broken-1.0.0.plugin': brokenBytes,
  };
  const index = [
    makeEntry('GoodOne', good),
    makeEntry('Liar', good, { file: 'Liar-1.0.0.plugin', 'file-url': 'plugins/Liar-1.0.0.plugin' }),
    makeEntry('BadDigest', badDigestPkg, { sha256: 'a'.repeat(64) }),
    makeEntry('Traversal', traversalPkg, { file: '../../Traversal.plugin' }),
    {
      name: 'Broken', slug: 'Broken', version: '1.0.0', author: 'market-test',
      file: 'Broken-1.0.0.plugin', 'file-url': 'plugins/Broken-1.0.0.plugin',
      sha256: sha256(brokenBytes), size: brokenBytes.length,
      requirements: [], loadAfter: [], incompatible: [],
    },
  ];

  const fake = await startFakeSource({ index, files });
  const h = await makeHost({
    offline: false,
    extraSources: [{ id: 'fake', name: 'Fake', kind: 'remote', base: fake.base, trustable: true, enabled: true }],
  });
  try {
    const good1 = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'GoodOne' }),
    })).json();
    ok('a well-formed remote package installs', good1.ok === true, JSON.stringify(good1));
    const before = readdirSync(h.plugins).sort().join(',');
    const beforeBytes = readFileSync(join(h.plugins, 'GoodOne-1.0.0.plugin'));

    const liar = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Liar' }),
    })).json();
    eq('a package whose manifest claims another slug is refused', liar.ok, false);
    ok('and says so', /slug/.test(liar.error), liar.error);

    const badDigest = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'BadDigest' }),
    })).json();
    eq('a sha256 mismatch is refused', badDigest.ok, false);
    ok('and says so', /sha256/.test(badDigest.error), badDigest.error);

    const broken = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Broken' }),
    })).json();
    eq('an unreadable archive is refused', broken.ok, false);

    const traversal = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Traversal' }),
    })).json();
    eq('a path-traversal file name is refused', traversal.ok, false);

    eq('the plugin directory is untouched by every refusal',
      readdirSync(h.plugins).sort().join(','), before);
    ok('and the previously installed archive is byte-identical',
      readFileSync(join(h.plugins, 'GoodOne-1.0.0.plugin')).equals(beforeBytes));
    ok('no staging files were left behind',
      readdirSync(h.plugins).every((n) => !n.startsWith('.bncm-tmp-')));
  } finally {
    await h.close();
    await fake.close();
  }
}

/* =========================================== 5. dependencies, cycles, updates === */
console.log('\n== 5. dependency resolution, cycles and updates ==');
{
  const leaf = makePackage('Leaf');
  const mid = makePackage('Mid', { requirements: ['Leaf'] });
  const top = makePackage('Top', { requirements: ['Mid'] });
  const cycA = makePackage('CycA', { requirements: ['CycB'] });
  const cycB = makePackage('CycB', { requirements: ['CycA'] });
  const orphan = makePackage('Orphan', { requirements: ['Ghost'] });
  const oldV1 = makePackage('Fresh', { version: '1.0.0' });
  const newV2 = makePackage('Fresh', { version: '2.0.0' });

  const files = {
    'plugins/Leaf-1.0.0.plugin': leaf,
    'plugins/Mid-1.0.0.plugin': mid,
    'plugins/Top-1.0.0.plugin': top,
    'plugins/CycA-1.0.0.plugin': cycA,
    'plugins/CycB-1.0.0.plugin': cycB,
    'plugins/Orphan-1.0.0.plugin': orphan,
    'plugins/Fresh-1.0.0.plugin': oldV1,
  };
  const index = [
    makeEntry('Leaf', leaf), makeEntry('Mid', mid), makeEntry('Top', top),
    makeEntry('CycA', cycA), makeEntry('CycB', cycB), makeEntry('Orphan', orphan),
    makeEntry('Fresh', oldV1),
  ];
  const fake = await startFakeSource({ index, files });
  const h = await makeHost({
    offline: false,
    extraSources: [{ id: 'fake', name: 'Fake', kind: 'remote', base: fake.base, trustable: true, enabled: true }],
  });
  try {
    const chain = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Top' }),
    })).json();
    const order = chain.installed.map((x) => x.slug);
    eq('a dependency chain is installed deepest-first', order.join('>'), 'Leaf>Mid>Top');

    const cyc = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'CycA' }),
    })).json();
    eq('a dependency cycle is refused', cyc.ok, false);
    ok('and the message names the cycle', /成环/.test(cyc.error), cyc.error);

    const ghost = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Orphan' }),
    })).json();
    eq('a missing requirement aborts the install', ghost.ok, false);
    ok('nothing of the dependent plugin was written',
      !readdirSync(h.plugins).some((n) => n.startsWith('Orphan')));

    // Now publish 2.0.0 of Fresh and check the update path.
    files['plugins/Fresh-2.0.0.plugin'] = newV2;
    index[index.findIndex((p) => p.slug === 'Fresh')] = makeEntry('Fresh', newV2);
    await h.api('/api/market/settings', { method: 'POST', body: JSON.stringify({}) });
    const first = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Fresh' }),
    })).json();
    eq('the older version installs first', first.installed[0].version, '1.0.0');

    const idx = await (await h.api('/api/market/plugins?refresh=1')).json();
    const fresh = idx.plugins.find((p) => p.slug === 'Fresh');
    eq('the newer version is offered as an update', fresh.update_available, true);
    eq('against the installed version', fresh.installed_version, '1.0.0');

    const upd = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Fresh' }),
    })).json();
    eq('updating writes the new version', upd.installed[0].version, '2.0.0');
    ok('the previous archive is moved aside, not deleted', !!upd.installed[0].replaced
      && existsSync(upd.installed[0].replaced));
    const names = readdirSync(h.plugins).filter((n) => n.startsWith('Fresh'));
    eq('only one Fresh archive remains live', names.length, 1);
    eq('and it is the new one', names[0], 'Fresh-2.0.0.plugin');
  } finally {
    await h.close();
    await fake.close();
  }
}

/* ==================================================== 6. themes are exclusive === */
console.log('\n== 6. themes stay mutually exclusive ==');
{
  const a = makePackage('ThemeA', { type: 'theme' });
  const b = makePackage('ThemeB', { type: 'theme' });
  const files = { 'plugins/ThemeA-1.0.0.plugin': a, 'plugins/ThemeB-1.0.0.plugin': b };
  const index = [makeEntry('ThemeA', a), makeEntry('ThemeB', b)];
  const fake = await startFakeSource({ index, files });
  const h = await makeHost({
    offline: false,
    extraSources: [{ id: 'fake', name: 'Fake', kind: 'remote', base: fake.base, trustable: true, enabled: true }],
  });
  try {
    await h.api('/api/market/install', { method: 'POST', body: JSON.stringify({ slug: 'ThemeA' }) });
    await h.api('/api/market/install', { method: 'POST', body: JSON.stringify({ slug: 'ThemeB' }) });
    const live = readdirSync(h.plugins).filter((n) => n.startsWith('Theme'));
    eq('only the newer theme is live', live.join(','), 'ThemeB-1.0.0.plugin');
    const archived = existsSync(join(h.data, '_uninstalled'));
    ok('the displaced theme was archived, not deleted', archived);
  } finally {
    await h.close();
    await fake.close();
  }
}

/* ============================================== 7. source failures and merging === */
console.log('\n== 7. a dead source degrades, the built-in source does not ==');
{
  const dead = 'http://127.0.0.1:1/market/';
  const h = await makeHost({
    offline: false, marketTtlMs: 0,
    extraSources: [{ id: 'dead', name: 'Dead mirror', kind: 'remote', base: dead, trustable: true, enabled: true }],
  });
  try {
    const idx = await (await h.api('/api/market/plugins')).json();
    eq('the built-in source still resolves', idx.sources.find((s) => s.builtin).ok, true);
    eq('the built-in source still lists four plugins',
      idx.plugins.filter((p) => p.bundled).length, 4);
    // An ordinary page load never waits for the network: an unfetched mirror is "pending", not a
    // failure, and must not delay the four plugins that live on local disk.
    const pending = idx.sources.find((s) => s.id === 'dead');
    eq('an unfetched mirror is reported as pending', pending.pending, true);
    ok('and it does not block the built-in source', !!idx.sources.find((s) => s.builtin).ok);

    const refreshed = await (await h.api('/api/market/plugins?refresh=1')).json();
    const failed = refreshed.sources.find((s) => s.id === 'dead');
    eq('an explicit refresh reports it as failed', failed.ok, false);
    ok('with a reason', !!failed.error, JSON.stringify(failed));
    eq('the built-in source is unaffected by the failure',
      refreshed.plugins.filter((p) => p.bundled).length, 4);

    const install = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'NCM-Font-Manager' }),
    })).json();
    ok('installing from the built-in source still works', install.ok === true);
    ok('the Font Manager archive landed',
      readdirSync(h.plugins).includes('NCM-Font-Manager-0.1.3.plugin'));
  } finally {
    await h.close();
  }
}

/* ================================================= 8. custom sources and trust === */
console.log('\n== 8. an untrusted source cannot install ==');
{
  const pkg = makePackage('Custom');
  const files = { 'plugins/Custom-1.0.0.plugin': pkg };
  const fake = await startFakeSource({ index: [makeEntry('Custom', pkg)], files });
  const h = await makeHost({ offline: false });
  try {
    const added = await (await h.api('/api/market/settings', {
      method: 'POST', body: JSON.stringify({ add_source: { base: fake.base } }),
    })).json();
    ok('the custom source was added', added.ok === true);
    const custom = added.sources.find((s) => s.custom);
    ok('and is untrusted by default', custom && custom.trustable === false, JSON.stringify(custom));

    const refused = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Custom' }),
    })).json();
    eq('installing from it is refused', refused.ok, false);
    ok('and the message says why', /不受信任|未解锁/.test(refused.error), refused.error);

    await h.api('/api/market/settings', {
      method: 'POST', body: JSON.stringify({ custom_unlocked: true }),
    });
    const allowed = await (await h.api('/api/market/install', {
      method: 'POST', body: JSON.stringify({ slug: 'Custom' }),
    })).json();
    ok('after unlocking, the install goes through', allowed.ok === true, JSON.stringify(allowed));

    const removed = await (await h.api('/api/market/settings', {
      method: 'POST', body: JSON.stringify({ remove_source: custom.id }),
    })).json();
    ok('the custom source can be removed again',
      removed.ok === true && !removed.sources.some((s) => s.id === custom.id));

    const bad = await h.api('/api/market/settings', {
      method: 'POST', body: JSON.stringify({ add_source: { base: 'file:///etc/passwd' } }),
    });
    eq('a non-http source is refused', bad.status, 400);
  } finally {
    await h.close();
    await fake.close();
  }
}

/* ==================================================== 9. uninstall is reversible === */
console.log('\n== 9. uninstalling moves, never deletes ==');
{
  await main.api('/api/market/install', { method: 'POST', body: JSON.stringify({ slug: 'NCM-Font-Manager' }) });
  const before = readdirSync(main.plugins).length;
  const gone = await (await main.api('/api/plugins/uninstall', {
    method: 'POST', body: JSON.stringify({ slug: 'NCM-Font-Manager' }),
  })).json();
  ok('uninstall reports where the file went', !!gone.moved_to, JSON.stringify(gone));
  ok('the archive is still on disk', existsSync(gone.moved_to));
  eq('and no longer in the plugin directory', readdirSync(main.plugins).length, before - 1);
  const idx = await (await main.api('/api/market/plugins')).json();
  eq('the market now reports it as not installed',
    idx.plugins.find((p) => p.slug === 'NCM-Font-Manager').installed, false);
}

/* ========================================================== 10. disabling market === */
console.log('\n== 10. the market can be switched off ==');
{
  const h = await makeHost({ offline: true, market: false });
  try {
    eq('market endpoints report it is disabled',
      (await h.api('/api/market/plugins')).status, 404);
  } finally {
    await h.close();
  }
}

await main.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
