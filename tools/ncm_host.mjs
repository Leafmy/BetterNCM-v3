// ncm_host.mjs -- BetterNCM-compatible backend for the NetEase client.
//
// Why a Node backend instead of in-process C++
// --------------------------------------------
// Upstream BetterNCM hosts its API inside the client: the injected framework.js talks to a
// loopback httplib server started by App.cpp in the CEF host process, plus an embedded
// framework.js resource.  Reproducing that needs the CEF headers and vcpkg dependencies,
// which are not obtainable here (libcef clone blocked; see docs/05-compat-matrix.md).
//
// Nothing in the API surface actually requires being in-process, though.  This host provides
// the same loopback HTTP API, keyed with an API key exactly like upstream, and serves
// framework.js straight off disk (so the framework can be edited and re-injected without a
// rebuild).  The already-working version.dll proxy stays responsible for anything that must
// live inside the client.
//
// Endpoints (all require the X-BNCM-Key header except /framework.js):
//   GET  /api/app/version            loader version string
//   GET  /api/app/datapath           BetterNCM data directory
//   GET  /api/app/ncmpath            NetEase install directory
//   GET  /api/plugins                installed plugins: user (plugins/) + core (plugins/core/)
//   GET  /api/plugin/<slug>/<path>   a file inside a plugin (core first, then user)
//   GET  /api/market/sources         plugin-market sources (built-in + opt-in mirrors + custom)
//   GET  /api/market/plugins         merged market index, annotated with installed/update state
//   POST /api/market/install         install a plugin and its requirements (verified, atomic)
//   POST /api/market/settings        select/enable sources, add custom sources, unlock untrusted
//   POST /api/market/cache/clear     drop the market's index + preview caches
//   GET  /api/market/preview?slug=   a plugin's preview image (proxied/cached by the host)
//   GET  /api/state                  plugin manager snapshot (core+user, disable list, build info)
//   GET  /api/hijacks                aggregated hijack rules for the document-start preload
//                                    (built-ins + plugin manifests + dev-mode rules)
//   GET  /api/selectors              versioned DOM selector registry for this client build
//   GET  /api/perf                   host-side counters: discovery cache, archive I/O, log flushes
//   GET  /api/dev/status             dev mode: sources, watch state, reload generation
//   POST /api/dev/sources/add        register a dev plugin source (dir / zip / GitHub repo)
//   POST /api/dev/sources/remove     drop a dev plugin source
//   POST /api/dev/reload             rescan dev sources, bump the reload generation
//   POST /api/dev/watch              turn host-side change detection on/off
//   GET  /api/dev/hooks              dev-mode hijack rules
//   POST /api/dev/hooks/add          add a dev-mode hijack rule (applies after a page reload)
//   POST /api/dev/hooks/clear        drop all dev-mode hijack rules
//   GET  /framework.js               the JS runtime to inject
//   GET  /preload.js                 the document-start bootstrap to inject
//   POST /api/plugins/<action>       disable|enable|uninstall (core plugins are rejected: 403)
//   POST /api/fs/<op>                exists|listDir|readFileText|writeFileText|readFile|
//                                    writeFile|mkdir|remove  (confined to the data directory)
//   POST /api/log                    append a line to the host log
//
// Usage: node tools/ncm_host.mjs [--port 0] [--data DIR] [--ncm E:\CloudMusic]
//                                [--plugins DIR] [--core-plugins DIR] [--key HEX] [--json]
//                                [--dev-dir DIR | --dev-source SPEC]... [--dev-watch]
//                                [--dev-watch-ms N] [--dev-fetch-ms N]

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
  rmSync, appendFileSync, realpathSync, renameSync,
} from 'node:fs';
import { join, resolve, dirname, sep, posix, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMarket } from './market_host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_DATA = process.env.BETTERNCM_PROFILE || 'C:\\betterncm';
const DEFAULT_PLUGINS = join(REPO, 'plugins');
const FRAMEWORK = join(REPO, 'loader', 'framework.js');
const PRELOAD = join(REPO, 'tools', 'bncm_preload.js');
const MANAGER = join(REPO, 'loader', 'manager.js');

/* Core ("built-in") plugins.
 *
 * The three big plugins used to ship here and were force-locked (no disable / no uninstall, a
 * 403 from this host rather than only a badge in the UI).  They are now ordinary user plugins,
 * so this directory is EMPTY by default and nothing is locked.
 *
 * The mechanism is kept because it is the honest way to express "this one must not be removed",
 * and keeping it costs nothing while nothing lives there: no path, no core plugin, no lock.
 * Pass --core-plugins DIR to use it. */
const DEFAULT_CORE_PLUGINS = null;
const HIJACKS_FILE = join(REPO, 'loader', 'hijacks.json');
const SELECTORS_FILE = join(REPO, 'loader', 'selectors.json');
/* The bundled plugin market source.  `market/` is derived from plugins/ by
 * tools/market/build_market.py, so the four plugins the repository ships are always listed by the
 * built-in source -- and the same directory can be published verbatim as a remote source. */
const MARKET_DIR = join(REPO, 'market');

/* ---------------------------------------------------------------- stats ---- */
/* Host-side instrumentation.  Cache effectiveness and archive I/O are reported by /api/perf so a
 * "the manager got slow with 40 plugins" report can be answered with numbers instead of guesswork. */
export const hostStats = {
  requests: 0,
  discovery: { calls: 0, cache_hits: 0, revalidations: 0, ms_total: 0, invalidations: 0 },
  zip: { opens: 0, entries: 0, bytes_inflated: 0 },
  files: { served: 0, not_modified: 0, bytes: 0, cached: 0 },
  log: { lines: 0, flushes: 0, bytes: 0 },
};

/* ---------------------------------------------------------------- zip ---- */
/**
 * Minimal ZIP reader, enough for BetterNCM .plugin files (manifest.json + js at root).
 *
 * Central-directory driven so prepended data and directory entries are harmless.  It is LAZY: the
 * central directory is parsed once, and an entry's bytes are only inflated when that entry is
 * asked for.  That matters because plugins ship single-file bundles that can be hundreds of
 * kilobytes; the eager reader inflated every entry of every archive to serve one script, and did it
 * again on every request.
 */
export function readZipArchive(buf) {
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  // Prepended bytes shift every recorded offset; recover the shift the same way readers do.
  const concat = eocd - cdSize - cdOff;

  const entries = new Map();          // name -> { method, compSize, dataStart }
  let p = cdOff + concat;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42) + concat;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (!name.endsWith('/') && compSize > 0) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (buf.readUInt16LE(localOff + 8) & 0x1) throw new Error(`${name}: encrypted entry`);
      entries.set(name, { method, compSize, dataStart });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  hostStats.zip.opens++;

  const inflated = new Map();
  const archive = {
    size: entries.size,
    has: (name) => entries.has(name),
    keys: () => entries.keys(),
    get(name) {
      if (!entries.has(name)) return undefined;
      if (inflated.has(name)) return inflated.get(name);
      const e = entries.get(name);
      const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
      const data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      hostStats.zip.entries++;
      hostStats.zip.bytes_inflated += data.length;
      inflated.set(name, data);
      return data;
    },
    entries() {
      const it = entries.keys();
      return {
        [Symbol.iterator]() { return this; },
        next() {
          const n = it.next();
          if (n.done) return { done: true, value: undefined };
          return { done: false, value: [n.value, archive.get(n.value)] };
        },
      };
    },
    [Symbol.iterator]() { return archive.entries(); },
  };
  return archive;
}

/** Eager variant, kept because callers (and tests) rely on the Map shape. */
export function readZip(buf) {
  const archive = readZipArchive(buf);
  const files = new Map();
  for (const name of archive.keys()) files.set(name, archive.get(name));
  return files;
}

/* ----------------------------------------------------------- plugins ---- */

/** Normalise a BetterNCM manifest into the shape framework.js consumes.
 *
 *  `ncm3_compatible` is deliberately TRI-STATE (true / false / null).  Collapsing "absent"
 *  into false would make the loader skip plugins that simply never set the flag -- which,
 *  measured against the 22 real plugins in C:\\betterncm\\plugins, is 17 of 22 (77%).
 *  Only an explicit false should cause a skip.
 */
function normaliseManifest(m, slug) {
  const raw = m['ncm3-compatible'];
  const tri = (raw === undefined || raw === null) ? null : raw === true;
  return {
    slug: m.slug || slug,
    name: m.name || slug,
    version: m.version || '0.0.0',
    author: m.author || 'unknown',
    description: m.description || '',
    type: m.type || 'extension',
    manifest_version: m.manifest_version ?? 1,
    betterncm_version: m.betterncm_version || '>=1.0.0',
    ncm_version_req: m['ncm-version-req'] || '> 2.10.2',
    ncm3_compatible: tri,
    ncm3_declared: raw !== undefined && raw !== null,
    injects: m.injects || {},
    hijacks: m.hijacks || {},
    /* Ordering metadata MUST survive normalisation.
     *
     * framework.js's orderPlugins() sorts plugins by `manifest.loadAfter` / `manifest.requirements`,
     * and it reads those from exactly this object (the page consumes GET /api/plugins, not the raw
     * manifest.json inside the archive).  Dropping them here silently turned the documented chain
     * MaterialYouTheme <- RefinedNowPlaying <- (requirements/loadAfter) <- LyricBar into plain
     * alphabetical order, so LyricBar could be evaluated before the plugin it declares a
     * requirement on.  The unit test that covers orderPlugins feeds the page a hand-made entry, so
     * it could never catch this: only a test through discoverPlugins()/normaliseManifest can.
     *
     * `incompatible` is carried for the same reason -- a plugin declares who it conflicts with,
     * and the contract should not be lost on the way to the loader. */
    loadAfter: Array.isArray(m.loadAfter) ? m.loadAfter.slice() : [],
    requirements: Array.isArray(m.requirements) ? m.requirements.slice() : [],
    incompatible: Array.isArray(m.incompatible) ? m.incompatible.slice() : [],
    /* Purely informational fields, carried for provenance rather than for the loader: the manager
     * UI and anything asking "where did this plugin come from" reads them off /api/plugins, and the
     * fixed key list silently dropped them too (test/plugin-ordering.test.mjs case A). */
    author_links: Array.isArray(m.author_links) ? m.author_links.slice() : [],
    preview: m.preview || null,
    source: m.source || null,
    startup_script: m.startup_script || 'startup_script.js',
    native_plugin: m.native_plugin || null,
    hide: m.hide === true,
  };
}

/** A cheap freshness signature for a plugins directory: names + mtimes + sizes, one stat each.
 *
 *  This is what makes caching honest: re-reading every `.plugin` archive to find out whether
 *  anything changed costs the size of the whole plugin set, while stat-ing the directory costs
 *  one syscall per plugin.  A rename (install / uninstall) moves the directory mtime too. */
function dirSignature(dir) {
  try {
    const names = readdirSync(dir).sort();
    const parts = [String(dir)];
    for (const n of names) {
      try {
        const st = statSync(join(dir, n));
        parts.push(`${n}:${st.mtimeMs}:${st.size}:${st.isDirectory() ? 1 : 0}`);
      } catch { parts.push(`${n}:gone`); }
    }
    return parts.join('|');
  } catch {
    return null;                      // directory missing -- caller reports zero plugins
  }
}

/** dir -> { sig, at, entries }.  Entries hold the parsed manifest and a LAZY archive handle. */
const discoveryCache = new Map();
/** `<plugin dir>|<rel>` -> { data, etag }: the exact bytes already inflated for a plugin file. */
const fileCache = new Map();
const FILE_CACHE_MAX = 128;
let discoveryTtlMs = 1000;
let discoveryCacheEnabled = true;

/** Drop every cached scan.  Called by anything that mutates the plugin set. */
export function invalidateDiscovery() {
  discoveryCache.clear();
  fileCache.clear();
  hostStats.discovery.invalidations++;
}

/** Discover plugins: unpacked directories and .plugin zips, same as upstream's plugins/.
 *
 *  Cached because the caller (the page) asks once per plugin FILE: with an eager scan a 40-plugin
 *  set re-read and re-inflated every archive once per script request, so simply adding plugins made
 *  each request cost more than the last.  Freshness is checked two ways -- a short TTL covers a
 *  boot burst, and after that a signature comparison notices installs without reading any archive.
 */
export function discoverPlugins(dir, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  const cached = discoveryCache.get(dir);
  if (discoveryCacheEnabled && !force && cached) {
    if (now - cached.at < (opts.ttlMs === undefined ? discoveryTtlMs : opts.ttlMs)) {
      hostStats.discovery.cache_hits++;
      return cloneEntries(cached.entries);
    }
    hostStats.discovery.revalidations++;
    const sig = dirSignature(dir);
    if (sig !== null && sig === cached.sig) {
      cached.at = now;
      hostStats.discovery.cache_hits++;
      return cloneEntries(cached.entries);
    }
  }
  const t0 = Date.now();
  const entries = scanPlugins(dir);
  hostStats.discovery.calls++;
  hostStats.discovery.ms_total += Date.now() - t0;
  if (discoveryCacheEnabled) {
    discoveryCache.set(dir, { sig: dirSignature(dir), at: now, entries });
  }
  // A full scan means something may have changed underneath us -- a rebuilt archive, a replaced
  // .plugin.  Dropping the served-bytes cache here is what keeps the ETag/304 path from serving a
  // file whose validator no longer describes it.
  fileCache.clear();
  return cloneEntries(entries);
}

/** Never hand out the cached entry objects themselves: callers annotate and republish them. */
function cloneEntries(entries) {
  return entries.map((e) => ({ ...e }));
}

function scanPlugins(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        const mf = join(full, 'manifest.json');
        if (!existsSync(mf)) continue;
        const m = JSON.parse(readFileSync(mf, 'utf8'));
        out.push({ kind: 'dir', dir: full, manifest: normaliseManifest(m, entry) });
      } else if (entry.endsWith('.plugin')) {
        const zip = readZipArchive(readFileSync(full));
        const mf = zip.get('manifest.json');
        if (!mf) continue;
        const m = JSON.parse(mf.toString('utf8'));
        out.push({
          kind: 'zip',
          dir: full,
          files: zip,
          manifest: normaliseManifest(m, entry.replace(/\.plugin$/, '')),
        });
      }
    } catch (err) {
      out.push({ kind: 'error', dir: full, manifest: null, error: err.message });
    }
  }
  out.sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
  return out;
}

/* ------------------------------------------------------- core / disabled ---- */

/** The set of user-plugin slugs the user switched off, persisted in the data directory.
 *  Core plugins never appear here and are ignored on read, so a stale entry cannot lock a
 *  built-in plugin out.
 *
 *  Memoised on the file's stat signature for the same reason plugin discovery is: it is consulted
 *  on every plugin-file request, and re-reading + re-parsing it per request is pure waste. */
const disabledCache = new Map();
function readDisabled(dataDir) {
  const file = join(dataDir, 'disabled_plugins.json');
  let sig;
  try { const st = statSync(file); sig = `${st.mtimeMs}:${st.size}`; } catch { sig = 'absent'; }
  const hit = disabledCache.get(file);
  if (hit && hit.sig === sig) return new Set(hit.set);
  let set = new Set();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) set = new Set(raw.map(String));
  } catch { /* absent or unreadable -> nothing disabled */ }
  disabledCache.set(file, { sig, set });
  return new Set(set);
}

function writeDisabled(dataDir, set) {
  const file = join(dataDir, 'disabled_plugins.json');
  writeFileSync(file, JSON.stringify([...set].sort(), null, 1), 'utf8');
  disabledCache.delete(file);
}

/** Discover both plugin classes at once and annotate them.
 *
 *  `locked` is the single source of truth the UI and the write endpoints both consult:
 *  a locked plugin has no enable/disable control and cannot be uninstalled.
 *
 *  Dev-mode sources (`o.dev`, set up by startHost) are returned as ordinary USER plugins with
 *  `dev: true`.  That is deliberate: a plugin under development must go through exactly the same
 *  loading path as a shipped one, or dev mode would be lying to its user about what will happen
 *  after packaging. */
function discoverAll(o) {
  const disabled = readDisabled(o.data);
  const core = (o.corePlugins ? discoverPlugins(o.corePlugins) : []).map((p) => ({
    ...p,
    core: true,
    locked: true,
    lock_reason: 'built-in plugin shipped with the loader',
    disabled: false,
  }));
  const installed = discoverPlugins(o.plugins).map((p) => ({
    ...p,
    core: false,
    locked: false,
    lock_reason: null,
    disabled: p.manifest ? disabled.has(p.manifest.slug) : false,
  }));
  let devEntries = [];
  if (o.dev) {
    const taken = new Set(installed.map((p) => p.manifest && p.manifest.slug).filter(Boolean));
    devEntries = discoverDev(o.dev, taken, o.dev.log || (() => {}));
  }
  const user = [
    ...installed,
    ...devEntries.map((p) => ({
      ...p,
      core: false,
      locked: false,
      lock_reason: null,
      dev: true,
      disabled: p.manifest ? disabled.has(p.manifest.slug) : false,
    })),
  ];
  return { core, user, disabled, dev: devEntries };
}

/** Find one plugin by slug across both classes.  Core wins on a slug collision: a user copy
 *  of a built-in plugin must never shadow the shipped one. */
function findAll(o, slug) {
  const { core, user } = discoverAll(o);
  const match = (p) => p.manifest && (
    p.manifest.slug === slug ||
    String(p.dir).endsWith(slug) ||
    String(p.dir).endsWith(`${slug}.plugin`)
  );
  const hitCore = core.find(match);
  if (hitCore) return hitCore;
  return user.find(match) || null;
}

function jsonOrEmpty(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Aggregate hijack rules for the document-start preload.
 *
 *  Sources, in order: the standalone loader/hijacks.json (built-in rules such as the lyrics
 *  hook) and each plugin manifest's `hijacks` map.  The preload cannot wait for the plugin
 *  loader, so this list must be servable before any chunk executes.
 *
 *  A manifest entry may delegate to a builtin rule instead of carrying its own pattern
 *  (`{"type":"module","rule":"builtin:lyrics-hook"}`); it is expanded here, so the preload
 *  only ever sees concrete from/to pairs.  Delegated rules inherit `pending` from the
 *  builtin definition, which is what keeps an underived rule from being reported as applied. */
function aggregateHijacks(o) {
  const book = jsonOrEmpty(HIJACKS_FILE, null);
  const builtins = new Map();
  if (book && Array.isArray(book.rules)) {
    for (const r of book.rules) builtins.set(r.id, r);
  }

  const rules = [];
  // Built-in rules are always published, including pending ones: the UI needs to be able to
  // say "this capability is required but not yet derived" rather than showing nothing.
  for (const r of builtins.values()) {
    rules.push({
      id: r.id,
      slug: r.slug || null,
      origin: 'builtin',
      builtin: true,
      url: null,
      type: r.type || 'module',
      from: r.from || null,
      to: r.to || null,
      // wrap-export rules carry a locate/wrapper pair instead of from/to.
      locate: r.locate || null,
      wrapper: r.wrapper || null,
      pending: r.pending === true || !isRuleComplete(r),
      derived_from_pack: r.derived_from_pack || null,
    });
  }

  const { core, user } = discoverAll(o);
  for (const p of [...core, ...user]) {
    const m = p.manifest;
    if (!m || !m.hijacks) continue;    for (const [range, targets] of Object.entries(m.hijacks)) {
      for (const [url, spec] of Object.entries(targets || {})) {
        const delegated = spec && spec.rule ? builtins.get(spec.rule) : null;
        if (spec && spec.rule && !delegated) {
          console.warn(`  [hijacks] ${m.slug} delegates to unknown builtin rule ${spec.rule}`);
        }
        // A delegated rule is emitted from the builtin definition, so the preload only ever sees
        // concrete, actionable rules.
        const source = delegated || spec || {};
        const rule = {
          id: delegated ? `${m.slug}::${url}` : `${m.slug}::${url}`,
          slug: m.slug,
          origin: 'manifest',
          builtin: false,
          version_range: range,
          url,
          type: source.type || 'replace',
          rule: spec && spec.rule ? spec.rule : null,
          from: source.from || null,
          to: source.to || null,
          locate: source.locate || null,
          wrapper: source.wrapper || null,
          derived_from_pack: source.derived_from_pack || null,
        };
        // `pending` MUST inherit from the builtin a manifest delegates to.  Computing it from
        // from/to alone meant disabling a builtin (pending: true, e.g. because enabling it broke
        // the client) left the delegated manifest copy live -- and the rule kept applying.
        rule.pending = (delegated && delegated.pending === true) || !isRuleComplete(rule);
        rules.push(rule);
      }
    }
  }

  // Dev-mode rules: ad-hoc hijacks an author added from the page (/api/dev/hooks/add).  They are
  // published exactly like manifest rules so nothing downstream needs to know they are special;
  // `origin: 'dev'` is what the diagnostics panel shows.  A dev rule may delegate to a builtin
  // too, which is how an author tests a shipped rule without enabling it for everyone.
  if (o.dev && Array.isArray(o.dev.hooks)) {
    for (const h of o.dev.hooks) {
      if (!h || !h.id) continue;
      const delegated = h.rule ? builtins.get(h.rule) : null;
      const source = delegated || h;
      const rule = {
        id: `dev:${h.id}`,
        slug: source.slug || `dev:${h.id}`,
        origin: 'dev',
        builtin: false,
        version_range: h.version_range || '*',
        url: h.url || 'dev:adhoc',
        type: source.type || 'replace',
        rule: h.rule || null,
        from: source.from || null,
        to: source.to || null,
        locate: source.locate || null,
        wrapper: source.wrapper || null,
        derived_from_pack: source.derived_from_pack || null,
      };
      rule.pending = (delegated && delegated.pending === true) || !isRuleComplete(rule);
      rules.push(rule);
    }
  }
  return rules;
}

/** A rule is actionable only when it carries what its type needs. */
function isRuleComplete(r) {
  if (!r) return false;
  if (r.type === 'wrap-export') return !!(r.locate && r.wrapper);
  return !!(r.from && r.to);
}

/** Read one file out of a plugin, whichever container it lives in.
 *
 *  Fallback: some published .plugin archives declare an injects path that does not match
 *  their own layout (e.g. BetterCloudSearch 1.4 declares "./dist/main.js" while the archive
 *  stores "main.js" at the root).  Rather than 500, fall back to a unique basename match and
 *  report it, so the plugin still loads and the mismatch is visible in the log.
 */
function pluginFile(plugin, rel) {
  const safe = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (safe.includes('..')) throw new Error('path traversal rejected');

  if (plugin.kind === 'zip') {
    const hit = plugin.files.get(safe);
    if (hit) return hit;
    const base = safe.split('/').pop();
    const matches = [...plugin.files.keys()].filter((k) => k.split('/').pop() === base);
    if (matches.length === 1) {
      console.warn(`  [plugin] ${rel} not in archive; using ${matches[0]} (basename fallback)`);
      return plugin.files.get(matches[0]);
    }
    throw new Error(`not found in plugin: ${safe}`);
  }

  const full = join(plugin.dir, ...safe.split('/'));
  if (!resolve(full).startsWith(resolve(plugin.dir))) throw new Error('path traversal rejected');
  if (existsSync(full)) return readFileSync(full);
  const base = safe.split('/').pop();
  let matches = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === base) matches.push(p);
    }
  };
  walk(plugin.dir);
  if (matches.length === 1) {
    console.warn(`  [plugin] ${rel} not found; using ${matches[0]} (basename fallback)`);
    return readFileSync(matches[0]);
  }
  throw new Error(`not found in plugin: ${safe}`);
}

/* ------------------------------------------------------------ dev mode ---- */
/*
 * Why this exists
 * ---------------
 * A plugin author currently has to pack a .plugin, drop it into the plugins directory and restart
 * (or at least re-inject) to see a change, and there is no way at all to try a page-level hijack
 * rule without editing loader/hijacks.json in the checkout.  Dev mode removes both round trips:
 *
 *   - plugin sources: a local directory, a local/remote .plugin|.zip, or a GitHub repo
 *     ("owner/repo", "owner/repo#ref", "owner/repo#ref:subdir", or a github.com URL).  GitHub
 *     sources are fetched as a codeload tarball and served straight out of memory, so the author
 *     only pushes to GitHub and hits reload.
 *   - change detection: local directories are watched by mtime; remote sources are re-fetched on
 *     a slow interval and compared by content hash.  Either way the reload `generation` bumps,
 *     and the page polls /api/dev/status and reloads the plugin list itself.
 *   - ad-hoc hijack rules: /api/dev/hooks/add persists a rule in <data>/dev_hijacks.json, which
 *     aggregateHijacks() merges into what the document-start preload fetches.  No checkout edit.
 *
 * Everything here is opt-in: with no --dev-dir / --dev-source and no persisted dev state, none of
 * this code runs and /api/dev/status reports enabled:false.
 */

const DEV_CACHE_DIRNAME = 'dev-cache';
const DEV_SOURCES_FILE = 'dev_sources.json';
const DEV_HIJACKS_FILE = 'dev_hijacks.json';

function sha1(buf) { return createHash('sha1').update(buf).digest('hex'); }

/** id for a dev source: stable for the same input, so re-adding is idempotent. */
function devSourceId(input) { return sha1(String(input)).slice(0, 12); }

/** Parse a dev source spec into { type, input, path?, url?, ref?, subdir? }.
 *
 *  Accepted forms:
 *    E:\some\plugin            a directory (also a drive-relative or ./relative path)
 *    ...\thing.plugin          a local .plugin / .zip archive
 *    https://.../x.plugin      a remote archive (release asset)
 *    owner/repo                GitHub, default branch
 *    owner/repo#v1.2.3         GitHub, tag / branch / commit
 *    owner/repo#v1.2.3:dist    ... and the plugin lives in the `dist/` subdirectory
 *    https://github.com/o/r    a github.com URL (optionally /tree/<ref>/<subdir>)
 */
export function parseDevSource(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('empty dev source');
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { throw new Error(`not a usable URL: ${raw}`); }
    const host = u.hostname.toLowerCase();
    if (host === 'github.com' || host === 'www.github.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) throw new Error(`expected github.com/<owner>/<repo>, got ${raw}`);
      const [owner, repoRaw] = parts;
      const repo = repoRaw.replace(/\.git$/, '');
      let ref = null, subdir = null;
      if (parts[2] === 'tree' && parts[3]) {
        ref = parts[3];
        subdir = parts.slice(4).join('/') || null;
      }
      return { type: 'github', input: raw, repo: `${owner}/${repo}`, ref, subdir };
    }
    return { type: 'url', input: raw, url: raw };
  }
  // owner/repo[#ref][:subdir] shorthand.  A single path segment or an existing path is a file.
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:#([^:\s]+))?(?::([^\s]+))?$/.exec(raw);
  const looksLikePath = /[\\/]/.test(raw) && (existsSync(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('.') || raw.startsWith('\\\\'));
  if (m && !existsSync(raw) && !looksLikePath && !/\.(plugin|zip)$/i.test(raw)) {
    return { type: 'github', input: raw, repo: `${m[1]}/${m[2]}`, ref: m[3] || null, subdir: m[4] || null };
  }
  const full = resolve(raw);
  if (!existsSync(full)) throw new Error(`dev source does not exist and is not a github spec: ${raw}`);
  if (statSync(full).isDirectory()) return { type: 'dir', input: raw, path: full };
  return { type: 'zip', input: raw, path: full };
}

/** Minimal tar reader, enough for a GitHub codeload tarball (ustar/pax headers, no symlinks). */
export function untar(buf) {
  const files = new Map();
  const cstr = (b, off, len) => {
    let end = off;
    while (end < off + len && b[end] !== 0) end++;
    return b.toString('utf8', off, end);
  };
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = cstr(header, 0, 100);
    const size = parseInt(cstr(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cstr(header, 345, 155);
    const full = (prefix ? `${prefix}/` : '') + name;
    const dataStart = off + 512;
    if ((type === '0' || type === '\0') && name) {
      files.set(full, Buffer.from(buf.subarray(dataStart, dataStart + size)));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Turn a codeload tarball into a plugin file map: drop the "<repo>-<ref>/" prefix and a trailing
 *  subdirectory if the spec asked for one. */
export function tarToPluginFiles(tarball, subdir) {
  const all = untar(gunzipSync(tarball));
  const names = [...all.keys()];
  if (!names.length) throw new Error('tarball is empty');
  // GitHub's codeload wraps the repo in a single "<repo>-<ref>/" directory, which has to go or
  // the manifest would never be found.  Do NOT trust names[0] for that: a pax_global_header
  // entry (or any root-level file) can precede the real tree, so pick the SHORTEST path that has
  // a slash and treat its first segment as the wrapper.
  const withSlash = names.filter((n) => n.includes('/'));
  const top = withSlash.length
    ? withSlash.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0].split('/')[0]
    : null;
  const strip = top ? `${top}/` : '';
  const out = new Map();
  for (const [name, data] of all) {
    if (strip && !name.startsWith(strip)) continue;
    let rel = strip ? name.slice(strip.length) : name;
    if (!rel) continue;
    if (subdir) {
      const prefix = `${subdir.replace(/^\.?\//, '').replace(/\/$/, '')}/`;
      if (rel !== subdir && !rel.startsWith(prefix)) continue;
      rel = rel === subdir ? '' : rel.slice(prefix.length);
      if (!rel) continue;
    }
    out.set(rel, data);
  }
  if (!out.size) throw new Error(subdir ? `no files under "${subdir}" in the tarball` : 'tarball has no files');
  return out;
}

/** Locate a manifest.json in a plugin file map, preferring the shallowest path.
 *  Authors often keep the plugin in dist/ or a subdirectory; failing the whole source over that
 *  would be hostile, so the same "search, then report" rule as pluginFile() applies. */
function findManifestEntry(files) {
  if (files.has('manifest.json')) return 'manifest.json';
  const candidates = [...files.keys()].filter((k) => k.endsWith('/manifest.json'));
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return candidates[0] || null;
}

/** A compact, deterministic fingerprint of a plugin source, used to detect remote changes. */
function sourceFingerprint(entry) {
  if (entry.kind === 'dir') return null;                       // dirs use mtime instead
  const parts = [];
  for (const [name, data] of [...entry.files.entries()].sort()) {
    parts.push(`${name}:${data.length}:${sha1(data)}`);
  }
  return sha1(parts.join('\n'));
}

/** Walk a directory and return the newest mtime + a file count, skipping noise directories. */
function dirFingerprint(dir) {
  let newest = 0, count = 0;
  // `dist` must NOT be skipped: for most plugins the built bundle IS the plugin, and rebuilding
  // into dist/ is exactly the change the author wants to see picked up.
  const skip = new Set(['node_modules', '.git', '.cache']);
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full, depth + 1); continue; }
      try { const st = statSync(full); count++; if (st.mtimeMs > newest) newest = st.mtimeMs; } catch { /* ignore */ }
    }
  };
  walk(dir, 0);
  return { newest, count };
}

/** Resolve a dev source into one plugin entry (kind dir/zip), or throw with a useful message. */
function materialiseDevSource(entry, opts) {
  if (entry.type === 'dir') {
    const mf = join(entry.path, 'manifest.json');
    if (!existsSync(mf)) throw new Error(`no manifest.json in ${entry.path}`);
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    return {
      kind: 'dir', dir: entry.path, manifest: normaliseManifest(m, basename(entry.path)),
      dev: true, dev_source: entry.id, dev_type: 'dir', dev_input: entry.input,
    };
  }
  if (entry.type === 'zip') {
    const zip = readZip(readFileSync(entry.path));
    const mf = findManifestEntry(zip);
    if (!mf) throw new Error(`no manifest.json in ${entry.path}`);
    const m = JSON.parse(zip.get(mf).toString('utf8'));
    return {
      kind: 'zip', dir: entry.path, files: zip, manifest: normaliseManifest(m, mf.split('/')[0]),
      dev: true, dev_source: entry.id, dev_type: 'zip', dev_input: entry.input, manifest_path: mf,
    };
  }
  // remote (github / url) -- entry.files is filled in by refreshRemoteSource.
  if (!entry.files) throw new Error(`source not fetched yet: ${entry.input}`);
  const mf = findManifestEntry(entry.files);
  if (!mf) throw new Error(`no manifest.json in ${entry.input}`);
  const m = JSON.parse(entry.files.get(mf).toString('utf8'));
  return {
    kind: 'zip', dir: entry.input, files: entry.files, manifest: normaliseManifest(m, mf.split('/')[0]),
    dev: true, dev_source: entry.id, dev_type: entry.type, dev_input: entry.input, manifest_path: mf,
  };
}

/** Fetch a remote dev source into memory.  GitHub goes through codeload (no API token, no
 *  rate limit); anything else is expected to be a .plugin/.zip archive. */
async function fetchRemoteSource(entry) {
  if (entry.type === 'github') {
    const ref = entry.ref || 'HEAD';
    const url = `https://codeload.github.com/${entry.repo}/tar.gz/${encodeURIComponent(ref)}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`codeload ${res.status} for ${entry.repo}#${ref}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { files: tarToPluginFiles(buf, entry.subdir), url, bytes: buf.length };
  }
  const res = await fetch(entry.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { files: readZip(buf), url: entry.url, bytes: buf.length };
}

/** Load the persisted dev state (sources + hijack rules) and merge CLI-provided sources. */
function loadDevState(o, log) {
  const dir = join(o.data, DEV_CACHE_DIRNAME);
  const state = {
    dir,
    generation: 0,
    last_change_at: null,
    last_change: null,
    watch: { enabled: false, interval_ms: o.devWatchMs || 5000, timer: null },
    sources: [],
    hooks: [],
  };
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const persisted = jsonOrEmpty(join(o.data, DEV_SOURCES_FILE), []);
  const inputs = [];
  for (const s of Array.isArray(persisted) ? persisted : []) {
    if (s && s.input) inputs.push({ input: s.input, from_state: true });
  }
  for (const input of o.devSources || []) inputs.push({ input, from_cli: true });

  const seen = new Set();
  for (const { input, from_state, from_cli } of inputs) {
    let spec;
    try { spec = parseDevSource(input); }
    catch (err) {
      log(`dev source rejected: ${input} (${err.message})`);
      if (from_state) state.sources.push({ id: devSourceId(input), input, error: err.message });
      continue;
    }
    const id = devSourceId(spec.input);
    if (seen.has(id)) continue;
    seen.add(id);
    state.sources.push({
      id, input: spec.input, type: spec.type, repo: spec.repo || null, ref: spec.ref ?? null,
      subdir: spec.subdir || null, url: spec.url || null, path: spec.path || null,
      added_at: new Date().toISOString(), from_cli: !!from_cli, error: null,
      files: null, fingerprint: null, fetched_at: null, bytes: null,
    });
  }

  const persistedHooks = jsonOrEmpty(join(o.data, DEV_HIJACKS_FILE), []);
  state.hooks = Array.isArray(persistedHooks) ? persistedHooks : [];
  return state;
}

/** Refresh every remote source (network) and recompute fingerprints; returns changed source ids.
 *
 *  Used both on demand (/api/dev/reload) and by the watch loop, which calls it lazily: remote
 *  fetches are throttled to `o.devFetchMs` so a 5 s watch does not hammer GitHub. */
async function refreshRemoteSources(state, o, log, { force = false } = {}) {
  const changed = [];
  const now = Date.now();
  for (const entry of state.sources) {
    if (entry.type === 'dir' || entry.type === 'zip') continue;
    if (entry.error && !force) { /* keep the error visible, retry on explicit reload */ }
    const last = entry.fetched_at ? Date.parse(entry.fetched_at) : 0;
    if (!force && last && now - last < (o.devFetchMs || 15000)) continue;
    const before = entry.fingerprint;
    try {
      const got = await fetchRemoteSource(entry);
      entry.files = got.files;
      entry.fingerprint = sha1([...got.files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, d]) => `${n}:${d.length}:${sha1(d)}`).join('\n'));
      entry.bytes = got.bytes;
      entry.fetched_at = new Date().toISOString();
      entry.error = null;
      if (before && before !== entry.fingerprint) changed.push(entry.id);
    } catch (err) {
      entry.error = err.message;
      entry.files = entry.files || null;
      log(`dev source fetch failed: ${entry.input} (${err.message})`);
    }
  }
  return changed;
}

/** One change-detection pass over every source.  Local dirs compare mtimes, remote sources
 *  compare content fingerprints (throttled).  Any change bumps the reload generation. */
async function devScan(state, o, log, { force = false, why = null } = {}) {
  const changed = [];
  for (const entry of state.sources) {
    if (entry.type === 'dir') {
      const fp = dirFingerprint(entry.path);
      const key = `${fp.newest}:${fp.count}`;
      if (entry.fingerprint && entry.fingerprint !== key) changed.push(entry.id);
      entry.fingerprint = key;
    } else if (entry.type === 'zip') {
      let key = null;
      try { const st = statSync(entry.path); key = `${st.mtimeMs}:${st.size}`; } catch { /* ignore */ }
      if (key && entry.fingerprint && entry.fingerprint !== key) changed.push(entry.id);
      if (key) entry.fingerprint = key;
    }
  }
  const remoteChanged = await refreshRemoteSources(state, o, log, { force });
  changed.push(...remoteChanged);

  const unique = [...new Set(changed)];
  if (unique.length) {
    state.generation++;
    state.last_change_at = new Date().toISOString();
    state.last_change = {
      why: why || (unique.length === 1 ? 'source changed' : 'sources changed'),
      sources: unique,
    };
    log(`dev: reload generation ${state.generation} (${unique.join(', ')})`);
  }
  return unique;
}

/** Plugin entries contributed by dev sources.  Installed plugins always win on a slug clash: a
 *  dev source must never silently shadow the user's real installation. */
function discoverDev(state, installedSlugs, log) {
  const out = [];
  const seen = new Set();
  for (const entry of state.sources) {
    try {
      const p = materialiseDevSource(entry, {});
      if (installedSlugs.has(p.manifest.slug)) {
        log(`dev source ${entry.input} skipped: slug "${p.manifest.slug}" is already installed`);
        continue;
      }
      if (seen.has(p.manifest.slug)) {
        log(`dev source ${entry.input} skipped: slug "${p.manifest.slug}" comes from an earlier dev source`);
        continue;
      }
      seen.add(p.manifest.slug);
      p.dir = p.dir || entry.input;
      out.push(p);
    } catch (err) {
      entry.error = entry.error || err.message;
      out.push({ kind: 'error', dir: entry.input, manifest: null, error: err.message,
                 dev: true, dev_source: entry.id, dev_input: entry.input });
    }
  }
  return out;
}

/* --------------------------------------------------------------- host ---- */

function parseArgs(argv) {
  const o = {
    port: 0, host: '127.0.0.1', data: DEFAULT_DATA, ncm: 'E:\\CloudMusic',
    plugins: DEFAULT_PLUGINS, corePlugins: DEFAULT_CORE_PLUGINS,
    key: randomBytes(16).toString('hex'), json: false,
    quiet: false, descriptor: null,
    // dev mode: sources from the CLI and/or <data>/dev_sources.json
    devSources: [], devWatchMs: 5000, devFetchMs: 15000, devWatch: false,
    // plugin discovery cache: a short TTL covers the loader's boot burst, then stat-based
    // revalidation.  --no-discovery-cache restores the old read-everything-per-request behaviour.
    discoveryTtlMs: 1000, discoveryCache: true,
    // plugin market: the bundled source is always available; remote sources are opt-in in the UI.
    market: true, marketDir: MARKET_DIR, marketOffline: false, marketTtlMs: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--data') o.data = next();
    else if (a === '--ncm') o.ncm = next();
    else if (a === '--plugins') o.plugins = next();
    else if (a === '--core-plugins') o.corePlugins = next();
    else if (a === '--key') o.key = next();
    else if (a === '--descriptor') o.descriptor = next();
    else if (a === '--dev-dir' || a === '--dev-source') o.devSources.push(next());
    else if (a === '--dev-watch') o.devWatch = true;
    else if (a === '--dev-watch-ms') o.devWatchMs = Math.max(500, Number(next()) || 5000);
    else if (a === '--dev-fetch-ms') o.devFetchMs = Math.max(1000, Number(next()) || 15000);
    else if (a === '--discovery-ttl-ms') o.discoveryTtlMs = Math.max(0, Number(next()) || 0);
    else if (a === '--no-discovery-cache') o.discoveryCache = false;
    else if (a === '--no-market') o.market = false;
    else if (a === '--market-dir') o.marketDir = next();
    else if (a === '--market-offline') o.marketOffline = true;
    else if (a === '--market-ttl-ms') o.marketTtlMs = Math.max(0, Number(next()) || 0);
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Confine every fs operation to the data directory. */
function safeJoin(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  const full = resolve(root, ...clean.split('/').filter((s) => s && s !== '.'));
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw new Error(`path escapes the data directory: ${rel}`);
  }
  return full;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startHost(opts = {}) {
  const o = { ...parseArgs([]), ...opts };
  if (!existsSync(o.data)) {
    try { mkdirSync(o.data, { recursive: true }); }
    catch (err) {
      // C:\betterncm may be unwritable; fall back next to the loader rather than fail.
      o.data = join(REPO, 'out', 'bncm-data');
      mkdirSync(o.data, { recursive: true });
    }
  }
  const logFile = join(o.data, 'host.log');
  /* Buffered log.  The old writer did an appendFileSync per line, and the loader logs once per
   * plugin: at 40 plugins that is 40 synchronous disk writes in the middle of boot, growing with
   * every plugin the user adds.  Lines are coalesced and flushed on a short timer, on demand
   * (test/dev tooling calls flushLog) and on process exit. */
  const logBuf = [];
  let logTimer = null;
  function flushLog() {
    if (logTimer) { clearTimeout(logTimer); logTimer = null; }
    if (!logBuf.length) return;
    const payload = logBuf.join('');
    logBuf.length = 0;
    try {
      appendFileSync(logFile, payload);
      hostStats.log.flushes++;
      hostStats.log.bytes += payload.length;
    } catch { /* ignore */ }
  }
  const log = (msg) => {
    hostStats.log.lines++;
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (!o.quiet) process.stdout.write(line);
    logBuf.push(line);
    if (logBuf.length >= 64) { flushLog(); return; }
    if (!logTimer) {
      logTimer = setTimeout(flushLog, 200);
      if (logTimer.unref) logTimer.unref();
    }
  };
  process.on('exit', flushLog);

  if (o.discoveryTtlMs !== undefined) discoveryTtlMs = o.discoveryTtlMs;
  if (o.discoveryCache === false) discoveryCacheEnabled = false;

  /* ------------------------------------------------------------ dev mode ---- */

  const devState = loadDevState(o, log);
  devState.log = log;
  o.dev = devState;

  const devEnabled = () => devState.sources.length > 0 || devState.hooks.length > 0 || devState.watch.enabled;

  function persistDevSources() {
    const file = join(o.data, DEV_SOURCES_FILE);
    try {
      writeFileSync(file, JSON.stringify(devState.sources.map((s) => ({ input: s.input, added_at: s.added_at })), null, 1), 'utf8');
    } catch (err) { log(`could not persist dev sources: ${err.message}`); }
  }
  function persistDevHooks() {
    const file = join(o.data, DEV_HIJACKS_FILE);
    try { writeFileSync(file, JSON.stringify(devState.hooks, null, 1), 'utf8'); }
    catch (err) { log(`could not persist dev hooks: ${err.message}`); }
  }

  function devSourceSummary(s) {
    let plugin = null;
    try {
      const p = materialiseDevSource(s, {});
      plugin = { slug: p.manifest.slug, name: p.manifest.name, version: p.manifest.version,
                 manifest_path: p.manifest_path || 'manifest.json' };
    } catch (err) { plugin = null; if (!s.error) s.error = err.message; }
    return {
      id: s.id, input: s.input, type: s.type, repo: s.repo, ref: s.ref, subdir: s.subdir,
      url: s.url, path: s.path, added_at: s.added_at, fetched_at: s.fetched_at,
      bytes: s.bytes, fingerprint: s.fingerprint, error: s.error, from_cli: !!s.from_cli,
      plugin,
    };
  }

  function devStatus() {
    let plugins = [];
    try {
      const { user } = discoverAll(o);
      plugins = user.filter((p) => p.dev && p.manifest)
        .map((p) => ({ slug: p.manifest.slug, version: p.manifest.version, dir: String(p.dir) }));
    } catch { /* ignore */ }
    return {
      enabled: devEnabled(),
      generation: devState.generation,
      watching: devState.watch.enabled,
      interval_ms: devState.watch.interval_ms,
      last_change_at: devState.last_change_at,
      last_change: devState.last_change,
      data_dir: o.data,
      sources: devState.sources.map(devSourceSummary),
      hooks: devState.hooks,
      plugins,
    };
  }

  function startDevWatch() {
    if (devState.watch.timer) return;
    devState.watch.enabled = true;
    devState.watch.timer = setInterval(() => {
      devScan(devState, o, log, {}).catch((e) => log(`dev watch error: ${e.message}`));
    }, devState.watch.interval_ms);
    // Never let the watcher hold the process open on its own.
    if (devState.watch.timer && typeof devState.watch.timer.unref === 'function') devState.watch.timer.unref();
    log(`dev watch on (${devState.watch.interval_ms} ms)`);
  }
  function stopDevWatch() {
    if (devState.watch.timer) clearInterval(devState.watch.timer);
    devState.watch.timer = null;
    devState.watch.enabled = false;
  }

  if (devState.sources.length) {
    await refreshRemoteSources(devState, o, log, { force: true });
    await devScan(devState, o, log, { force: true, why: 'host start' });
    log(`dev mode: ${devState.sources.length} source(s)` +
        (devState.hooks.length ? `, ${devState.hooks.length} dev hook(s)` : '') +
        `, generation ${devState.generation}`);
  }
  if (o.devWatch && devState.sources.length) startDevWatch();

  /* ------------------------------------------------------------- market ---- */
  /* The market is a host feature, not a plugin: it has to work when the plugin it would install
   * is the one that is broken, and it has to work with no network at all.  The bundled source is a
   * directory, so "install the four plugins this build ships" never depends on a mirror. */
  const market = o.market === false ? null : createMarket({
    data: o.data,
    pluginsDir: o.plugins,
    marketDir: o.marketDir,
    log,
    installedProvider: () => {
      const map = new Map();
      try {
        const { core, user } = discoverAll(o);
        for (const p of core.concat(user)) {
          const slug = p.manifest && p.manifest.slug;
          if (!slug) continue;
          map.set(slug, {
            version: (p.manifest && p.manifest.version) || null,
            dir: String(p.dir),
            disabled: p.disabled === true,
          });
        }
      } catch { /* an unreadable plugin set must not take the market down with it */ }
      return map;
    },
    onChange: () => invalidateDiscovery(),
    offline: o.marketOffline === true,
    ttlMs: o.marketTtlMs,
    // Test/embedder hook: replace the seeded source list (the built-in source is normally in it).
    sources: o.marketSources,
  });
  if (market) log(`market: built-in source at ${o.marketDir}` + (o.marketOffline ? ' (offline)' : ''));

  const server = createServer(async (req, res) => {
    hostStats.requests++;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, body, type = 'application/json; charset=utf-8', extra) => {
      res.writeHead(code, Object.assign({
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-BNCM-Key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      }, extra || {}));
      res.end(body);
    };
    const json = (obj, code = 200) => send(code, JSON.stringify(obj));

    /** Content-derived validator.  `no-cache` + ETag means the browser revalidates every time, so
     *  a re-injected page pays a 304 instead of re-downloading every plugin script -- and an edited
     *  plugin is still picked up immediately. */
    function etagOf(data) {
      return 'W/"' + data.length.toString(16) + '-' + sha1(data).slice(0, 20) + '"';
    }
    function serveCached(req2, res2, key, produce, type) {
      let entry = fileCache.get(key);
      if (!entry) {
        const data = produce();
        entry = { data, etag: etagOf(data) };
        if (fileCache.size >= FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value);
        fileCache.set(key, entry);
      }
      if (req2.headers['if-none-match'] === entry.etag) {
        hostStats.files.not_modified++;
        res2.writeHead(304, { 'ETag': entry.etag, 'Cache-Control': 'no-cache',
                              'Access-Control-Allow-Origin': '*' });
        return res2.end();
      }
      hostStats.files.served++;
      hostStats.files.bytes += entry.data.length;
      return send(200, entry.data, type, { 'ETag': entry.etag, 'Cache-Control': 'no-cache' });
    }
    /** Serve a checkout file (framework.js / preload.js / manager.js) with the same validators. */
    function serveDisk(req2, res2, file, type, missing) {
      let sig = 'missing';
      try { const st = statSync(file); sig = `${st.mtimeMs}:${st.size}`; }
      catch { return json({ error: missing }, 500); }
      return serveCached(req2, res2, `disk:${file}:${sig}`, () => readFileSync(file), type);
    }

    if (req.method === 'OPTIONS') return send(204, '');

    try {
      // framework.js is served without auth so injection is a single fetch.
      if (url.pathname === '/framework.js') {
        return serveDisk(req, res, FRAMEWORK, 'application/javascript; charset=utf-8', 'framework.js missing');
      }
      // The document-start preload: injected by Page.addScriptToEvaluateOnNewDocument, so it
      // runs before any of the client's chunks.  It installs the webpack interceptor and then
      // pulls framework.js itself.  Also unauthenticated, for the same reason.
      if (url.pathname === '/preload.js') {
        return serveDisk(req, res, PRELOAD, 'application/javascript; charset=utf-8',
                         'preload.js not built in this checkout');
      }
      // The plugin manager UI module, fetched by framework.js.
      if (url.pathname === '/manager.js') {
        return serveDisk(req, res, MANAGER, 'application/javascript; charset=utf-8',
                         'manager.js not built in this checkout');
      }

      // Upstream mounts the data directory at /local and exposes it to plugins as
      // window.BETTERNCM_FILES_PATH.  Deliberately read-only and unauthenticated: the path is
      // used in <img>/<audio> src attributes, which cannot carry the API key header.  It is
      // loopback-only and confined to the data directory.
      if (url.pathname.startsWith('/local/')) {
        const rel = decodeURIComponent(url.pathname.slice('/local/'.length));
        const full = safeJoin(o.data, rel);
        if (!existsSync(full) || statSync(full).isDirectory()) return json({ error: 'not found' }, 404);
        const ext = (rel.split('.').pop() || '').toLowerCase();
        const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
                        svg: 'image/svg+xml', webp: 'image/webp', css: 'text/css',
                        js: 'application/javascript', json: 'application/json',
                        txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8' };
        return send(200, readFileSync(full), types[ext] || 'application/octet-stream');
      }

      if (req.headers['x-bncm-key'] !== o.key) return json({ error: 'bad api key' }, 403);

      if (url.pathname === '/api/app/version') {
        // Upstream returns the version as plain TEXT from /app/version, not JSON.
        return send(200, '3.0.0-wip', 'text/plain; charset=utf-8');
      }
      if (url.pathname === '/api/app/datapath') return send(200, o.data, 'text/plain; charset=utf-8');
      if (url.pathname === '/api/app/ncmpath') return send(200, o.ncm, 'text/plain; charset=utf-8');
      if (url.pathname === '/api/app/is_light_theme') {
        // Best effort: the page sets a data attribute / class on <html> for dark mode.
        return json(false);
      }
      if (url.pathname === '/api/app/get_succeeded_hijacks') return json([]);

      // Top-level BetterNCM settings, i.e. the cc.microblock.* keys in <data>/config.json.
      // Signature mirrors upstream app.readConfig(key, defaultValue) -> text.
      if (url.pathname === '/api/app/read_config') {
        const key = url.searchParams.get('key') || '';
        const dflt = url.searchParams.get('default') ?? '';
        let value = dflt;
        try {
          const cfg = JSON.parse(readFileSync(join(o.data, 'config.json'), 'utf8'));
          if (cfg && cfg[key] !== undefined) value = String(cfg[key]);
        } catch { /* no config yet -> default */ }
        return send(200, value, 'text/plain; charset=utf-8');
      }
      if (url.pathname === '/api/app/write_config') {
        const key = url.searchParams.get('key') || '';
        const value = url.searchParams.get('value') ?? '';
        const file = join(o.data, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { cfg = {}; }
        if (typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
        cfg[key] = value;
        writeFileSync(file, JSON.stringify(cfg), 'utf8');
        return send(200, 'ok', 'text/plain; charset=utf-8');
      }

      if (url.pathname === '/api/plugins') {
        const { core, user } = discoverAll(o);
        const shape = (p) => ({
          dir: p.dir,
          kind: p.kind,
          error: p.error || null,
          manifest: p.manifest,
          core: p.core,
          locked: p.locked,
          lock_reason: p.lock_reason,
          disabled: p.disabled,
          dev: p.dev === true,
          dev_source: p.dev_source || null,
        });
        return json({
          plugins_dir: o.plugins,
          core_dir: o.corePlugins,
          plugins: user.map(shape),
          core: core.map(shape),
        });
      }

      /** Plugin manager snapshot: one call gives the UI everything it renders. */
      if (url.pathname === '/api/state') {
        const { core, user, disabled } = discoverAll(o);
        const brief = (p) => ({
          slug: p.manifest ? p.manifest.slug : null,
          name: p.manifest ? p.manifest.name : String(p.dir).split(/[\\/]/).pop(),
          version: p.manifest ? p.manifest.version : null,
          author: p.manifest ? p.manifest.author : null,
          description: p.manifest ? p.manifest.description : '',
          type: p.manifest ? p.manifest.type : null,
          dir: p.dir,
          kind: p.kind,
          error: p.error || null,
          core: p.core,
          locked: p.locked,
          lock_reason: p.lock_reason,
          disabled: p.disabled,
          dev: p.dev === true,
          has_manifest: !!p.manifest,
          hijacks: p.manifest ? Object.keys(p.manifest.hijacks || {}) : [],
        });
        return json({
          build: 'ncm_host',
          ncm: o.ncm,
          data_dir: o.data,
          plugins_dir: o.plugins,
          core_dir: o.corePlugins,
          disabled: [...disabled].sort(),
          core: core.map(brief),
          plugins: user.map(brief),
        });
      }

      /* ------------------------------------------------------------ market -- */

      /** Source list + which one is selected.  `builtin` is always enabled and cannot be removed. */
      if (url.pathname === '/api/market/sources' && req.method === 'GET') {
        if (!market) return json({ error: 'market disabled' }, 404);
        const s = market.sources();
        return json({ sources: s.all, selected: s.selected, custom_unlocked: s.customUnlocked });
      }

      /** The merged index.  Every failure is per-source and non-fatal: a dead mirror degrades to
       *  its cached copy, and the built-in source keeps working regardless. */
      if (url.pathname === '/api/market/plugins' && req.method === 'GET') {
        if (!market) return json({ error: 'market disabled' }, 404);
        return json(await market.index({ refresh: url.searchParams.get('refresh') === '1' }));
      }

      /** Install a plugin and everything it requires.  The reply lists what was written, what was
       *  skipped, and whether a reload is needed -- the UI never has to guess. */
      if (url.pathname === '/api/market/install' && req.method === 'POST') {
        if (!market) return json({ error: 'market disabled' }, 404);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        try {
          const result = await market.install(body);
          log(`market: install ${result.slug} -> ${result.installed.length} written, `
              + `${result.skipped.length} skipped`);
          return json(result);
        } catch (err) {
          log(`market: install ${body.slug} refused: ${err.message}`);
          return json({ ok: false, error: err.message }, 400);
        }
      }

      /** Source selection, enable/disable, custom sources, and the untrusted-source unlock. */
      if (url.pathname === '/api/market/settings' && req.method === 'POST') {
        if (!market) return json({ error: 'market disabled' }, 404);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        try {
          const s = market.updateSettings(body);
          return json({ ok: true, sources: s.all, selected: s.selected, custom_unlocked: s.customUnlocked });
        } catch (err) {
          return json({ ok: false, error: err.message }, 400);
        }
      }

      if (url.pathname === '/api/market/cache/clear' && req.method === 'POST') {
        if (!market) return json({ error: 'market disabled' }, 404);
        market.clearCache();
        return json({ ok: true });
      }

      /** Preview images are served through the host (authenticated, like every other API) so the
       *  page never talks to a plugin mirror directly and CSP stays a single-origin story. */
      if (url.pathname === '/api/market/preview' && req.method === 'GET') {
        if (!market) return json({ error: 'market disabled' }, 404);
        const slug = url.searchParams.get('slug') || '';
        const aggregate = await market.index({});
        const entry = aggregate.plugins.find((p) => p.slug === slug);
        const image = entry ? await market.preview(entry) : null;
        if (!image) return json({ error: 'no preview for ' + slug }, 404);
        hostStats.files.served++;
        hostStats.files.bytes += image.bytes.length;
        return send(200, image.bytes, image.type, { 'Cache-Control': 'no-cache' });
      }

      /** Hijack rules for the preload.  Must be servable before any chunk runs. */
      if (url.pathname === '/api/hijacks') {
        return json({ rules: aggregateHijacks(o) });
      }

      /* ------------------------------------------------------------ dev mode -- */

      if (url.pathname === '/api/dev/status') return json(devStatus());
      if (url.pathname === '/api/dev/hooks' && req.method === 'GET') {
        return json({ hooks: devState.hooks });
      }

      if (url.pathname.startsWith('/api/dev/') && req.method === 'POST') {
        const action = url.pathname.slice('/api/dev/'.length);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

        if (action === 'sources/add') {
          const spec = parseDevSource(body.source);
          const existing = devState.sources.find((s) => s.input === spec.input);
          if (existing) {
            await devScan(devState, o, log, { force: true, why: 'source re-added' });
            return json({ ok: true, existed: true, source: devSourceSummary(existing),
                          generation: devState.generation });
          }
          const entry = {
            id: devSourceId(spec.input), input: spec.input, type: spec.type,
            repo: spec.repo || null, ref: spec.ref ?? null, subdir: spec.subdir || null,
            url: spec.url || null, path: spec.path || null,
            added_at: new Date().toISOString(), from_cli: false, error: null,
            files: null, fingerprint: null, fetched_at: null, bytes: null,
          };
          devState.sources.push(entry);
          persistDevSources();
          await devScan(devState, o, log, { force: true, why: 'source added' });
          log(`dev source added: ${entry.input} (${entry.type})`);
          return json({ ok: true, source: devSourceSummary(entry), generation: devState.generation });
        }

        if (action === 'sources/remove') {
          const key = String(body.id || body.source || '');
          const before = devState.sources.length;
          devState.sources = devState.sources.filter((s) =>
            s.id !== key && s.input !== key && devSourceId(s.input) !== key);
          if (devState.sources.length === before) return json({ error: `no such dev source: ${key}` }, 404);
          persistDevSources();
          devState.generation++;
          log(`dev source removed: ${key} -> generation ${devState.generation}`);
          return json({ ok: true, generation: devState.generation, sources: devState.sources.map(devSourceSummary) });
        }

        if (action === 'reload') {
          const changed = await devScan(devState, o, log, { force: true, why: 'manual reload' });
          // An explicit reload always bumps the generation: the author asked for a re-load, and
          // "nothing changed on disk since my last save" is not a reason to deny it.
          devState.generation++;
          devState.last_change_at = new Date().toISOString();
          devState.last_change = { why: 'manual reload', sources: changed };
          log(`dev: manual reload -> generation ${devState.generation}`);
          return json({ ok: true, generation: devState.generation, changed });
        }

        if (action === 'watch') {
          if (body.interval_ms !== undefined) {
            devState.watch.interval_ms = Math.max(500, Number(body.interval_ms) || 5000);
          }
          if (body.enabled === false) stopDevWatch(); else startDevWatch();
          return json({ ok: true, watching: devState.watch.enabled, interval_ms: devState.watch.interval_ms });
        }

        if (action === 'hooks/add') {
          const r = body.rule || body;
          const id = String(r.id || r.name || '').trim() ||
            sha1(JSON.stringify([r.type, r.from, r.to, r.locate, r.wrapper, r.rule])).slice(0, 10);
          const rule = {
            id, slug: r.slug || null, type: r.type || 'replace', rule: r.rule || null,
            from: r.from || null, to: r.to || null, locate: r.locate || null,
            wrapper: r.wrapper || null, url: r.url || 'dev:adhoc',
            version_range: r.version_range || '*', added_at: new Date().toISOString(),
          };
          devState.hooks = devState.hooks.filter((h) => h.id !== id).concat([rule]);
          persistDevHooks();
          log(`dev hook added: ${id} (${rule.type}); applies after a page reload`);
          return json({ ok: true, hook: rule, hooks: devState.hooks, reload_required: true });
        }

        if (action === 'hooks/clear') {
          devState.hooks = [];
          persistDevHooks();
          log('dev hooks cleared; applies after a page reload');
          return json({ ok: true, hooks: [], reload_required: true });
        }

        return json({ error: `unknown dev action: ${action}` }, 400);
      }

      /** Versioned DOM selector registry.  Absent file is not an error: the framework then
       *  relies on its built-in fallbacks and the selector discovery routine. */
      if (url.pathname === '/api/selectors') {
        const reg = jsonOrEmpty(SELECTORS_FILE, null);
        if (!reg) return json({ version: null, builds: {} });
        return json(reg);
      }

      if (url.pathname.startsWith('/api/plugin/')) {
        const rest = url.pathname.slice('/api/plugin/'.length);
        const slash = rest.indexOf('/');
        if (slash < 0) return json({ error: 'expected /api/plugin/<slug>/<path>' }, 400);
        const slug = decodeURIComponent(rest.slice(0, slash));
        const rel = decodeURIComponent(rest.slice(slash + 1));
        const plugin = findAll(o, slug);
        if (!plugin) return json({ error: `no such plugin: ${slug}` }, 404);
        // Unpacked plugins are read straight through: they are the shape an author edits in place,
        // a directory's own mtime does not change when a file inside it is rewritten, and caching
        // them would hand back the previous revision.  Archives are the production case (one request
        // per script for the whole plugin set) and ARE cached -- their mtime/size is part of the
        // discovery signature, so replacing one invalidates both caches.
        if (plugin.kind !== 'zip') {
          const data = pluginFile(plugin, rel);
          hostStats.files.served++;
          hostStats.files.bytes += data.length;
          return send(200, data, 'application/javascript; charset=utf-8',
                      { 'Cache-Control': 'no-store' });
        }
        return serveCached(req, res, `plugin:${String(plugin.dir)}|${rel}`,
                           () => pluginFile(plugin, rel), 'application/javascript; charset=utf-8');
      }

      /** Host-side performance counters.  Used by test/host-scale.test.mjs and by anyone trying to
       *  answer "why did the manager get slower after I installed 40 plugins". */
      if (url.pathname === '/api/perf') {
        return json({
          requests: hostStats.requests,
          discovery: Object.assign({}, hostStats.discovery, {
            cache_entries: discoveryCache.size, ttl_ms: discoveryTtlMs, enabled: discoveryCacheEnabled,
          }),
          zip: Object.assign({}, hostStats.zip),
          files: Object.assign({}, hostStats.files, { cache_entries: fileCache.size }),
          log: Object.assign({}, hostStats.log),
        });
      }

      /** Enable / disable / uninstall.  Core plugins are rejected here as well as in the UI,
       *  so a hand-crafted request cannot remove a built-in plugin. */
      if (url.pathname.startsWith('/api/plugins/') && req.method === 'POST') {
        const action = url.pathname.slice('/api/plugins/'.length);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const slug = String(body.slug || '');
        if (!slug) return json({ error: 'slug is required' }, 400);
        if (!['disable', 'enable', 'uninstall'].includes(action)) {
          return json({ error: `unknown plugin action: ${action}` }, 400);
        }

        const plugin = findAll(o, slug);
        if (!plugin) return json({ error: `no such plugin: ${slug}` }, 404);
        if (plugin.core || plugin.locked) {
          log(`refused ${action} on core plugin ${slug}`);
          return json({
            error: 'core plugin is locked',
            detail: 'built-in plugins cannot be disabled or uninstalled',
            slug,
            action,
          }, 403);
        }

        if (action === 'disable' || action === 'enable') {
          const set = readDisabled(o.data);
          if (action === 'disable') set.add(slug); else set.delete(slug);
          writeDisabled(o.data, set);
          log(`${action}d plugin ${slug}`);
          return json({ ok: true, slug, disabled: action === 'disable' });
        }

        // uninstall: move, never delete -- the same reversibility rule as everywhere else.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = join(o.data, '_uninstalled', stamp);
        mkdirSync(dest, { recursive: true });
        const name = basename(String(plugin.dir));
        const target = join(dest, name);
        renameSync(plugin.dir, target);
        const set = readDisabled(o.data);
        set.delete(slug);
        writeDisabled(o.data, set);
        invalidateDiscovery();
        log(`uninstalled plugin ${slug} -> ${target}`);
        return json({ ok: true, slug, moved_to: target });
      }

      /** Selector-discovery reports from the page.
       *
       *  The frontend pack updates independently of the client and renames CSS-module classes,
       *  so the only durable defence is to LEARN the new names instead of guessing.  The page
       *  posts a bounded candidate snapshot whenever a selector in loader/selectors.json has no
       *  working value; this appends it to <data>/selector-discovery.json, which makes the next
       *  fix a data edit. */
      if (url.pathname === '/api/selector-report' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const file = join(o.data, 'selector-discovery.json');
        let all = [];
        try { all = JSON.parse(readFileSync(file, 'utf8')) || []; } catch { all = []; }
        all.push({ received_at: new Date().toISOString(), ...body });
        if (all.length > 200) all = all.slice(all.length - 200);
        writeFileSync(file, JSON.stringify(all, null, 1), 'utf8');
        log(`selector report: ${body.key} (${(body.candidates || []).length} candidates) -> ${file}`);
        return json({ ok: true });
      }

      if (url.pathname === '/api/log' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        // The loader batches page log lines ({messages:[...]}) so one plugin set costs one request
        // instead of one request per line; single {message} stays supported for older frameworks.
        if (Array.isArray(body.messages)) {
          const lines = body.messages.slice(0, 500);
          for (const m of lines) log(`[page] ${m}`);
          return json({ ok: true, lines: lines.length });
        }
        log(`[page] ${body.message ?? JSON.stringify(body)}`);
        return json({ ok: true, lines: 1 });
      }

      if (url.pathname.startsWith('/api/fs/') && req.method === 'POST') {
        const op = url.pathname.slice('/api/fs/'.length);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        switch (op) {
          case 'exists':
            return json({ value: existsSync(safeJoin(o.data, body.path)) });
          case 'listDir': {
            const d = safeJoin(o.data, body.path || '');
            if (!existsSync(d)) return json({ value: [] });
            const value = readdirSync(d).map((n) => {
              const st = statSync(join(d, n));
              return { name: n, isDirectory: st.isDirectory(), size: st.size };
            });
            return json({ value });
          }
          case 'readFileText':
            return json({ value: readFileSync(safeJoin(o.data, body.path), 'utf8') });
          case 'writeFileText': {
            const f = safeJoin(o.data, body.path);
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, String(body.content ?? ''), 'utf8');
            return json({ value: true });
          }
          case 'readFile':
            return json({ value: readFileSync(safeJoin(o.data, body.path)).toString('base64') });
          case 'writeFile': {
            const f = safeJoin(o.data, body.path);
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, Buffer.from(String(body.base64 ?? ''), 'base64'));
            return json({ value: true });
          }
          case 'mkdir':
            mkdirSync(safeJoin(o.data, body.path), { recursive: true });
            return json({ value: true });
          case 'remove':
            rmSync(safeJoin(o.data, body.path), { recursive: true, force: true });
            return json({ value: true });
          default:
            return json({ error: `unknown fs op: ${op}` }, 400);
        }
      }

      return json({ error: 'no such endpoint', path: url.pathname }, 404);
    } catch (err) {
      log(`error ${req.method} ${req.url}: ${err.message}`);
      return json({ error: err.message }, 500);
    }
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(o.port, o.host, done);
  });

  const port = server.address().port;
  const descriptor = {
    host: o.host, port, key: o.key, data: o.data, pluginsDir: o.plugins,
    corePluginsDir: o.corePlugins,
    market: market
      ? { enabled: true, dir: o.marketDir, offline: o.marketOffline === true }
      : { enabled: false },
    dev: devEnabled()
      ? { enabled: true, generation: devState.generation, watching: devState.watch.enabled,
          sources: devState.sources.map((s) => s.input), hooks: devState.hooks.length }
      : { enabled: false, generation: 0, watching: false, sources: [], hooks: 0 },
    api: `http://${o.host}:${port}`, started_at: new Date().toISOString(),
  };
  if (o.descriptor) {
    // The launcher polls this file to learn the ephemeral port and the API key.
    mkdirSync(dirname(resolve(o.descriptor)), { recursive: true });
    writeFileSync(resolve(o.descriptor), JSON.stringify(descriptor, null, 1), 'utf8');
  }
  server.on('close', () => stopDevWatch());
  log(`BetterNCM host listening on http://${o.host}:${port} (data=${o.data}, plugins=${o.plugins}, core=${o.corePlugins})` +
      (devEnabled() ? `, dev=${devState.sources.length} source(s)/${devState.hooks.length} hook(s)` : ''));
  return {
    server, ...descriptor, log,
    // The market object is exposed so tests can drive installs without HTTP (and so an embedder
    // can pre-warm the index at boot).
    market: market || null,
    // Exposed so tests (and any embedder) can drive dev mode without HTTP.
    dev: {
      status: devStatus,
      rescan: (opts) => devScan(devState, o, log, opts || {}),
      addSource: (input) => { const spec = parseDevSource(input); const id = devSourceId(spec.input);
        if (!devState.sources.some((s) => s.id === id)) {
          devState.sources.push({ id, input: spec.input, type: spec.type, repo: spec.repo || null,
            ref: spec.ref ?? null, subdir: spec.subdir || null, url: spec.url || null, path: spec.path || null,
            added_at: new Date().toISOString(), from_cli: false, error: null, files: null,
            fingerprint: null, fetched_at: null, bytes: null });
          persistDevSources();
        }
        return id; },
      refresh: () => refreshRemoteSources(devState, o, log, { force: true }),
      startWatch: startDevWatch,
      stopWatch: stopDevWatch,
    },
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('ncm_host.mjs [--port N] [--data DIR] [--plugins DIR] [--core-plugins DIR] [--key HEX] [--descriptor FILE] [--json]');
    console.log('             [--dev-dir DIR | --dev-source SPEC]... [--dev-watch] [--dev-watch-ms N] [--dev-fetch-ms N]');
    console.log('             [--discovery-ttl-ms N] [--no-discovery-cache]');
    console.log('             [--no-market] [--market-dir DIR] [--market-offline] [--market-ttl-ms N]');
    console.log('             SPEC: a directory, a .plugin/.zip path, an HTTP(S) archive URL, or');
    console.log('                   owner/repo[#ref][:subdir] / a github.com URL (fetched from codeload)');
    return 0;
  }
  const h = await startHost(o);
  if (o.json) {
    console.log(JSON.stringify({ port: h.port, host: h.host, key: h.key, data: h.data,
                                  plugins: h.pluginsDir, corePlugins: h.corePluginsDir }));
  } else {
    console.log(`port=${h.port} key=${h.key}`);
  }
  // This is a server: stay alive until interrupted.  (--json is only an announcement.)
  process.on('SIGINT', () => { h.server.close(); process.exit(0); });
  process.on('SIGTERM', () => { h.server.close(); process.exit(0); });
  return new Promise(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
