// market_host.mjs -- the BetterNCM plugin market, backend side.
//
// Upstream ships the market as a PLUGIN (BetterNCM/Plugin-Market, "PluginMarket1"): it fetches
// `<base>/plugins.json` from one of a few mirrors, renders the list, and writes the chosen
// `.plugin` archive into the plugin directory through `betterncm.fs.writeFile`.  That works, but
// it makes the market unavailable exactly when a user needs it most (no network, a dead mirror)
// and it cannot offer anything the mirrors do not have.
//
// This module keeps the upstream CONTRACT and fixes those two things:
//
//   * the index format is byte-for-byte upstream's -- a top-level ARRAY of objects with
//     name/author/version/slug/file/file-url/preview/… -- so a `market/` directory produced by
//     this repository can be published as an ordinary upstream-compatible source, and upstream's
//     own mirrors can be consumed here without a translation layer;
//   * one source is BUILT IN: `market/` next to the checkout (or inside the portable package),
//     read straight off disk.  It always resolves, it never 404s, and it is where the four
//     bundled plugins live, so "install LyricBar" works on a plane;
//   * an install is VERIFIED before it lands: the archive must parse as a zip, its root
//     manifest.json must be readable, its slug must match the slug that was requested, and the
//     sha256 recorded in the index (when the source provides one) must match.  A failed check
//     leaves the plugin directory untouched -- which is the whole point, because the previous
//     revision of a plugin is the only copy the user has.
//
// Anything that writes is confined to the plugin directory and the data directory, both of which
// the caller passes in; nothing here reaches outside them.

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';

export const INDEX_FILE = 'plugins.json';
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30000;
export const DEFAULT_INDEX_TIMEOUT_MS = 8000;

/** The bundled source has no URL; it is a directory.  Its id is stable and cannot be removed. */
export const BUILTIN_SOURCE_ID = 'builtin';

/**
 * Pre-seeded sources.
 *
 * `trustable` mirrors upstream's flag: only a trustable source (or an explicitly unlocked custom
 * one) may cause an archive to be written into the plugin directory.
 *
 * ONLY the bundled source is enabled by default, and that is a deliberate reversal of upstream's
 * "fetch a mirror on every open": the bundled source is on local disk (instant, offline), while
 * every mirror is a network round trip that can hang for the whole timeout.  A market that shows
 * four working plugins immediately and offers the rest one click away is better than one that
 * shows a spinner because a CDN is blocked.  The mirrors are all listed, all `trustable`, and one
 * checkbox away in the market's source panel.
 */
export const DEFAULT_SOURCES = [
  {
    id: BUILTIN_SOURCE_ID,
    name: '内置（随包分发）',
    kind: 'builtin',
    base: '',
    trustable: true,
    builtin: true,
    enabled: true,
    homepage: '',
    note: '随 BetterNCM-v3 一起分发的插件目录，离线可用',
  },
  {
    id: 'bncm-v3-github',
    name: 'BetterNCM-v3 市场源（主仓库）',
    kind: 'remote',
    base: 'https://raw.githubusercontent.com/Leafmy/BetterNCM-v3/main/market/',
    trustable: true,
    builtin: false,
    enabled: false,
    homepage: 'https://github.com/Leafmy/BetterNCM-v3',
    note: '主仓库 market/ 的在线副本，与下面的独立源仓库内容完全一致',
  },
  {
    id: 'better-ncm-plugin-market',
    name: 'BetterNCM-PluginMarket（独立源仓库）',
    kind: 'remote',
    base: 'https://raw.githubusercontent.com/Leafmy/BetterNCM-PluginMarket/main/',
    trustable: true,
    builtin: false,
    enabled: false,
    homepage: 'https://github.com/Leafmy/BetterNCM-PluginMarket',
    note: '独立发布的插件源仓库（已实测与主仓库 market/ 逐字节一致）；'
        + '本机 raw 直连被阻断，需要可达网络或镜像',
  },
  {
    id: 'upstream-unpkg',
    name: 'BetterNCM 官方源（Unpkg）',
    kind: 'remote',
    base: 'https://unpkg.com/betterncm-packed-plugins/',
    trustable: true,
    builtin: false,
    enabled: false,
    homepage: 'https://github.com/BetterNCM/BetterNCM-Packed-Plugins',
    note: '上游官方镜像，约 67 个插件（多数面向 2.x 客户端）',
  },
  {
    id: 'upstream-github',
    name: 'BetterNCM 官方源（GitHub raw）',
    kind: 'remote',
    base: 'https://raw.githubusercontent.com/BetterNCM/BetterNCM-Packed-Plugins/master/',
    trustable: true,
    builtin: false,
    enabled: false,
    homepage: 'https://github.com/BetterNCM/BetterNCM-Packed-Plugins',
    note: '上游官方镜像的第二个入口，与 Unpkg 同源',
  },
  {
    id: 'upstream-microblock',
    name: 'MicroBlock CDN（上游默认源）',
    kind: 'remote',
    base: 'https://bncm-plugin.microblock.cc/',
    trustable: true,
    builtin: false,
    enabled: false,
    homepage: '',
    note: '上游 sources.json 里的默认源；本机实测已不可达，保留以便上游恢复后自动可用',
  },
];

/* ------------------------------------------------------------------ helpers ---- */

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** A version string normalised for comparison: `v1.0.4` and `1.0.4` are the same release. */
export function normaliseVersion(v) {
  return String(v ?? '').trim().replace(/^[vV]/, '');
}

/** -1 / 0 / 1, tolerant of non-numeric segments (falls back to string comparison). */
export function compareVersions(a, b) {
  const pa = normaliseVersion(a).split(/[.\-+]/);
  const pb = normaliseVersion(b).split(/[.\-+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Read `manifest.json` straight out of a `.plugin` archive.
 *
 * Deliberately self-contained rather than importing ncm_host's reader: ncm_host imports THIS
 * module, and a cycle for thirty lines of zip parsing is not worth the coupling.  The layout is
 * the same one the host documents -- central directory first, offsets shifted by any prepended
 * bytes, entry bytes inflated lazily (here: only the manifest).
 */
export function readManifestFromZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) throw new Error('不是 zip 归档（找不到 end-of-central-directory）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const concat = eocd - cdSize - cdOff;
  let p = cdOff + concat;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42) + concat;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'manifest.json' || name === './manifest.json') {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 局部头损坏');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      const raw = method === 0 ? comp : inflateRawSync(comp);
      const manifest = JSON.parse(raw.toString('utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('manifest.json 不是对象');
      }
      return manifest;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('归档根目录没有 manifest.json');
}

/** Archive file names come from a remote index, so they are treated as hostile input. */
export function safePackageName(name, slug) {
  const s = String(name || '').trim();
  if (!s) return `${slug}.plugin`;
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.startsWith('.')) {
    throw new Error(`索引给出的文件名不安全：${JSON.stringify(name)}`);
  }
  if (!/^[A-Za-z0-9._+-]+\.plugin$/i.test(s)) {
    throw new Error(`索引给出的文件名不是 .plugin：${JSON.stringify(name)}`);
  }
  return s;
}

/** `sha256:`/`sha256-` prefixes and uppercase hex both appear in the wild. */
export function normaliseDigest(value) {
  const s = String(value || '').trim().toLowerCase();
  const hex = s.replace(/^sha256[:=-]?/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function contentTypeFor(rel) {
  const ext = String(rel).split('.').pop().toLowerCase();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  }[ext] || 'application/octet-stream';
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/* -------------------------------------------------------------------- market ---- */

/**
 * @param {object} opts
 * @param {string} opts.data          data directory (settings + caches live here)
 * @param {string} opts.pluginsDir    where installed `.plugin` archives land
 * @param {string} opts.marketDir     the built-in source directory (repository `market/`)
 * @param {(m:string)=>void} [opts.log]
 * @param {() => Map<string, any>} [opts.installedProvider] slug -> {version, dir, disabled}
 * @param {() => void} [opts.onChange] called after the plugin directory changed
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.ttlMs]
 * @param {boolean} [opts.offline]    never touch the network (tests, airplane mode)
 * @param {number[]} [opts.sources]   override the seeded source list (tests)
 */
export function createMarket(opts) {
  const data = resolve(opts.data);
  const pluginsDir = resolve(opts.pluginsDir);
  const marketDir = opts.marketDir ? resolve(opts.marketDir) : null;
  const log = opts.log || (() => {});
  const installedProvider = opts.installedProvider || (() => new Map());
  const onChange = opts.onChange || (() => {});
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const offline = opts.offline === true;
  const timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  // An index is a small JSON document; a package is not.  They get separate budgets so a blocked
  // mirror costs eight seconds, not thirty, while a large archive is still allowed to arrive.
  const indexTimeoutMs = opts.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
  const now = opts.now || (() => Date.now());

  const settingsFile = join(data, 'market.json');
  const cacheDir = join(data, 'market-cache');
  const previewCacheDir = join(cacheDir, 'previews');

  const memory = new Map();          // source id -> {at, plugins, error, source}
  const pendingFetches = new Map();  // source id -> in-flight background fetch

  function readSettings() {
    const base = { selected: null, enabled: {}, custom: [], custom_unlocked: false };
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) || {};
      return {
        selected: typeof parsed.selected === 'string' ? parsed.selected : null,
        enabled: (parsed.enabled && typeof parsed.enabled === 'object') ? parsed.enabled : {},
        custom: Array.isArray(parsed.custom) ? parsed.custom.filter((s) => s && s.base) : [],
        custom_unlocked: parsed.custom_unlocked === true,
      };
    } catch { return base; }
  }

  function writeSettings(next) {
    mkdirSync(data, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(next, null, 1), 'utf8');
  }

  function seedSources() {
    return (opts.sources || DEFAULT_SOURCES).map((s) => ({ ...s }));
  }

  /** Seeded sources + the user's custom ones, with `enabled` resolved from settings. */
  function sources() {
    const st = readSettings();
    const seeded = seedSources().map((s) => ({
      ...s,
      enabled: s.builtin ? true : (st.enabled[s.id] !== undefined ? st.enabled[s.id] === true : s.enabled),
    }));
    const custom = st.custom.map((c) => ({
      id: c.id, name: c.name || c.base, kind: 'remote', base: c.base,
      trustable: c.trustable === true, builtin: false,
      enabled: st.enabled[c.id] !== undefined ? st.enabled[c.id] === true : true,
      homepage: c.homepage || '', custom: true,
      note: c.trustable === true ? '自定义源（已标记可信）' : '自定义源：安装前需要在市场页解锁',
    }));
    const all = seeded.concat(custom);
    const selected = all.some((s) => s.id === st.selected) ? st.selected
      : (all.find((s) => s.enabled) || all[0]).id;
    return { all, selected, customUnlocked: st.custom_unlocked, settings: st };
  }

  function customSourceId(base) {
    return 'custom-' + sha256(String(base)).slice(0, 10);
  }

  /* ------------------------------------------------------------ index fetch ---- */

  function cacheFileFor(src) {
    const id = String(src.id).replace(/[^A-Za-z0-9._-]/g, '_');
    return join(cacheDir, `${id}.json`);
  }

  function readDiskCache(src) {
    try {
      const raw = JSON.parse(readFileSync(cacheFileFor(src), 'utf8'));
      if (!raw || !Array.isArray(raw.plugins)) return null;
      return raw;
    } catch { return null; }
  }

  function writeDiskCache(src, plugins) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFileFor(src),
        JSON.stringify({ id: src.id, base: src.base, at: now(), plugins }, null, 1), 'utf8');
    } catch (err) { log(`market: could not cache ${src.id}: ${err.message}`); }
  }

  async function readBuiltinIndex(src) {
    if (!marketDir) throw new Error('内置源目录不存在（本检出没有 market/）');
    const file = join(marketDir, INDEX_FILE);
    if (!existsSync(file)) throw new Error(`内置源没有 ${INDEX_FILE}`);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.plugins) ? parsed.plugins : null);
    if (!list) throw new Error('内置源的 plugins.json 不是数组');
    return list;
  }

  async function fetchJson(url) {
    if (typeof doFetch !== 'function') throw new Error('本运行时没有 fetch，无法使用在线源');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), indexTimeoutMs);
    try {
      const res = await doFetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'} ${res ? res.statusText : ''}`.trim());
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  /**
   * One source's index, with a four-level fallback: fresh fetch -> memory cache -> disk cache ->
   * "not fetched yet, doing it in the background".
   *
   * `allowNetwork: false` is the DEFAULT for the HTTP endpoint, and it is what keeps the market
   * usable: a mirror that hangs (a blocked host takes the full 15 s timeout) must not delay the
   * four plugins that are sitting on local disk.  The page therefore renders the built-in source
   * immediately, marks the remote ones "pending", and picks them up on the next pass -- while a
   * fetch runs in the background so that pass has something to show.
   */
  async function sourceIndex(src, { refresh = false, allowNetwork = false } = {}) {
    const cachedMemory = memory.get(src.id);
    if (!refresh && cachedMemory && now() - cachedMemory.at < ttlMs) {
      return { ...cachedMemory, cached: true, error: cachedMemory.error || null };
    }
    const disk = readDiskCache(src);

    if (src.kind === 'builtin') {
      try {
        const plugins = await readBuiltinIndex(src);
        const entry = { at: now(), plugins, error: null, source: src };
        memory.set(src.id, entry);
        return { ...entry, cached: false, error: null, from: 'disk' };
      } catch (err) {
        if (disk) return { ...disk, cached: true, error: err.message, source: src, from: 'cache' };
        return { at: now(), plugins: [], cached: false, error: err.message, source: src, from: 'disk' };
      }
    }

    const background = pendingFetches.get(src.id);
    if (!allowNetwork) {
      if (disk) return { ...disk, cached: true, error: null, source: src, from: 'cache' };
      if (offline) return { at: now(), plugins: [], cached: false, error: '离线模式：没有缓存可用', source: src, from: 'offline' };
      scheduleBackground(src);
      return { at: 0, plugins: [], cached: false, error: null, source: src, from: 'pending' };
    }

    if (offline) {
      if (disk) return { ...disk, cached: true, error: '离线模式：使用上次缓存', source: src, from: 'cache' };
      return { at: now(), plugins: [], cached: false, error: '离线模式：没有缓存可用', source: src, from: 'offline' };
    }

    try {
      const url = src.base.replace(/\/?$/, '/') + INDEX_FILE;
      const parsed = await fetchJson(`${url}?${now()}`);
      const plugins = Array.isArray(parsed) ? parsed
        : (parsed && Array.isArray(parsed.plugins) ? parsed.plugins : null);
      if (!plugins) throw new Error('plugins.json 不是数组');
      const entry = { at: now(), plugins, error: null, source: src };
      memory.set(src.id, entry);
      writeDiskCache(src, plugins);
      return { ...entry, cached: false, error: null, from: 'network' };
    } catch (err) {
      if (disk) {
        memory.set(src.id, { at: disk.at, plugins: disk.plugins, error: err.message, source: src });
        return { ...disk, cached: true, error: err.message, source: src, from: 'cache' };
      }
      return { at: now(), plugins: [], cached: false, error: err.message, source: src, from: 'failed' };
    } finally {
      pendingFetches.delete(src.id);
    }
  }

  /** Start (or join) a background fetch for one source.  Never awaited by a request path. */
  function scheduleBackground(src) {
    if (offline || pendingFetches.has(src.id)) return;
    const run = sourceIndex(src, { refresh: true, allowNetwork: true })
      .catch(() => null)
      .then(() => { pendingFetches.delete(src.id); });
    pendingFetches.set(src.id, run);
  }

  /** Version info the host already discovered, keyed by slug. */
  function installState() {
    const map = new Map();
    for (const [slug, info] of installedProvider() || []) {
      map.set(slug, {
        version: info.version || null,
        dir: info.dir || null,
        disabled: info.disabled === true,
      });
    }
    return map;
  }

  /**
   * Every enabled source, merged exactly the way upstream merges them: the first source to
   * mention a slug wins, and an `incompatible` entry is mirrored onto the plugin it names.
   *
   * `allowNetwork` defaults to `refresh`: an ordinary page load answers from disk + caches and
   * reports the rest as `pending`, while `?refresh=1` (and an install, which genuinely needs the
   * newest listing) is allowed to wait for the network.
   */
  async function index({ refresh = false, allowNetwork = refresh } = {}) {
    const { all, selected } = sources();
    const enabled = all.filter((s) => s.enabled);
    const order = [
      ...enabled.filter((s) => s.id === selected),
      ...enabled.filter((s) => s.id !== selected),
    ];
    const reports = await Promise.all(order.map(async (src) => {
      const r = await sourceIndex(src, { refresh, allowNetwork });
      return {
        id: src.id, name: src.name, kind: src.kind, base: src.base, enabled: true,
        trustable: !!src.trustable, builtin: !!src.builtin,
        ok: !r.error && r.from !== 'pending', error: r.error || null, count: r.plugins.length,
        fetched_at: r.at, cached: !!r.cached, from: r.from || null,
        pending: r.from === 'pending',
        plugins: r.plugins,
      };
    }));

    const plugins = [];
    const byslug = new Map();
    for (const report of reports) {
      for (const raw of report.plugins) {
        const slug = String(raw.slug || raw.name || '').trim();
        if (!slug) continue;
        if (byslug.has(slug)) continue;
        const entry = {
          ...raw,
          slug,
          name: raw.name || slug,
          version: raw.version !== undefined ? String(raw.version) : '',
          file: raw.file || `${slug}.plugin`,
          'file-url': raw['file-url'] || `plugins/${raw.file || `${slug}.plugin`}`,
          preview: raw.preview || null,
          requirements: Array.isArray(raw.requirements) ? raw.requirements : [],
          loadAfter: Array.isArray(raw.loadAfter) ? raw.loadAfter : [],
          incompatible: Array.isArray(raw.incompatible) ? raw.incompatible : [],
          stars: Number(raw.stars || 0) || 0,
          // Upstream aggregates download counts from its own API; the field is optional here, and
          // when a source provides it the composite sort uses the same bonus curve upstream does.
          downloads: Number(raw.downloads ?? raw.count ?? 0) || 0,
          publish_time: Number(raw.publish_time || 0) || 0,
          update_time: Number(raw.update_time || 0) || 0,
          bundled: raw.bundled === true || raw.source_id === BUILTIN_SOURCE_ID || report.builtin,
          source_id: report.id,
          source_name: report.name,
          source_base: report.base,
          source_kind: report.kind,
          source_trustable: report.trustable,
        };
        entry.download_url = entry.source_kind === 'builtin'
          ? null
          : new URL(entry['file-url'], entry.source_base.replace(/\/?$/, '/')).href;
        plugins.push(entry);
        byslug.set(slug, entry);
      }
    }

    for (const plugin of plugins) {
      for (const other of plugin.incompatible) {
        const target = byslug.get(other);
        if (!target) continue;
        if (!target.incompatible.includes(plugin.slug)) target.incompatible.push(plugin.slug);
      }
    }

    // Installed state is derived here, once, so the UI never has to join two lists itself.
    const installed = installState();
    for (const plugin of plugins) {
      const have = installed.get(plugin.slug);
      plugin.installed = !!have;
      plugin.installed_version = have ? have.version : null;
      plugin.installed_disabled = have ? have.disabled : false;
      plugin.installed_dir = have ? have.dir : null;
      plugin.update_available = !!(have && have.version
        && compareVersions(plugin.version, have.version) > 0);
      plugin.blocked_by = plugin.incompatible.filter((s) => installed.has(s));
    }
    // A plugin that is installed but no longer listed by any enabled source still belongs in the
    // picture: "installed, unknown origin" is a state the user can act on, "vanished" is not.
    for (const [slug, have] of installed) {
      if (byslug.has(slug)) continue;
      plugins.push({
        slug, name: slug, version: have.version || '', description: '',
        file: null, 'file-url': null, preview: null, requirements: [], incompatible: [],
        bundled: false, source_id: null, source_name: '(已不在任何已启用源中)',
        source_kind: null, source_base: null, source_trustable: false, download_url: null,
        installed: true, installed_version: have.version || null, installed_disabled: have.disabled,
        installed_dir: have.dir, update_available: false, blocked_by: [], unlisted: true,
      });
    }

    plugins.sort((a, b) => {
      if (a.unlisted !== b.unlisted) return a.unlisted ? 1 : -1;
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });

    return {
      plugins,
      sources: reports.map(({ plugins: _p, ...rest }) => rest),
      selected,
      custom_unlocked: sources().customUnlocked,
      fetched_at: now(),
      offline,
    };
  }

  /* --------------------------------------------------------------- install ---- */

  function locate(slug, wantVersion, aggregate) {
    const candidates = aggregate.plugins.filter((p) => p.slug === slug && !p.unlisted);
    if (!candidates.length) throw new Error(`任何已启用的源里都没有 ${slug}`);
    const exact = wantVersion
      ? candidates.find((c) => normaliseVersion(c.version) === normaliseVersion(wantVersion))
      : null;
    const chosen = exact || candidates.find((c) => c.bundled) || candidates[0];
    if (wantVersion && !exact) {
      throw new Error(`${slug} 没有版本 ${wantVersion}（可用的有 ${candidates.map((c) => c.version).join(', ')}）`);
    }
    return chosen;
  }

  /** Requirements first, then the plugin that asked for them; a cycle is an error, not a hang. */
  function plan(slug, aggregate, { includeInstalled = false, includeRecommended = false } = {}) {
    const byslug = new Map(aggregate.plugins.filter((p) => !p.unlisted).map((p) => [p.slug, p]));
    const ordered = [];
    const done = new Set();
    const walk = (s, chain, isRoot) => {
      // The cycle check must come FIRST: once a slug is in `done` the walk returns quietly, which
      // would turn A→B→A into a silent success.
      if (chain.includes(s)) throw new Error(`依赖成环：${chain.concat(s).join(' → ')}`);
      if (done.has(s)) return;
      const entry = byslug.get(s);
      if (!entry) {
        throw new Error(isRoot ? `任何已启用的源里都没有 ${s}` : `依赖 ${s} 在任何已启用的源里都找不到`);
      }
      const already = entry.installed && entry.installed_version
        && normaliseVersion(entry.installed_version) === normaliseVersion(entry.version);
      if (already && !includeInstalled && !isRoot) { done.add(s); return; }
      done.add(s);
      for (const dep of entry.requirements) walk(dep, chain.concat(s), false);
      // `loadAfter` is an ordering hint, not a requirement -- but a plugin that wants to load
      // after another one is usually broken without it, so it is offered as a recommendation
      // rather than silently installed.
      if (includeRecommended) for (const dep of entry.loadAfter) walk(dep, chain.concat(s), false);
      ordered.push({ entry, already, root: !!isRoot });
    };
    walk(slug, [], true);
    return ordered;
  }

  async function packageBytes(entry) {
    if (entry.source_kind === 'builtin') {
      if (!marketDir) throw new Error('没有内置源目录');
      const rel = String(entry['file-url'] || `plugins/${entry.file}`).replace(/\\/g, '/');
      if (rel.includes('..')) throw new Error('内置源给出的路径不安全');
      const full = join(marketDir, ...rel.split('/'));
      if (!existsSync(full)) throw new Error(`内置源缺少文件 ${rel}`);
      const buf = readFileSync(full);
      return { buf, from: 'builtin' };
    }
    if (!entry.download_url) throw new Error(`${entry.slug} 没有可用的下载地址`);
    if (offline) throw new Error('离线模式：无法下载在线插件');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(entry.download_url, { signal: controller.signal, redirect: 'follow' });
      if (!res || !res.ok) throw new Error(`下载失败：HTTP ${res ? res.status : '?'}`);
      const len = Number(res.headers?.get?.('content-length') || 0);
      if (len > MAX_PACKAGE_BYTES) throw new Error(`包过大（${len} 字节）`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, from: 'network' };
    } finally { clearTimeout(timer); }
  }

  /** Move the currently installed copy of `slug` aside (never delete) before replacing it. */
  function displaceInstalled(slug, installed) {
    const have = installed.get(slug);
    if (!have || !have.dir || !existsSync(have.dir)) return null;
    const dest = join(data, '_replaced', stamp());
    mkdirSync(dest, { recursive: true });
    const target = join(dest, basename(have.dir));
    renameSync(have.dir, target);
    log(`market: replaced ${slug} -> ${target}`);
    return target;
  }

  async function install(request) {
    const { slug, version = null } = request || {};
    if (!slug) throw new Error('slug 是必填项');
    const aggregate = await index({ refresh: request.refresh === true, allowNetwork: true });
    const steps = plan(String(slug), aggregate, {
      includeRecommended: request.include_recommended === true,
    });
    // `loadAfter` targets that are not being installed: reported, never installed silently.
    const pending = new Set(steps.map((s) => s.entry.slug));
    const recommended = [];
    for (const step of steps) {
      for (const after of step.entry.loadAfter || []) {
        if (pending.has(after)) continue;
        const target = aggregate.plugins.find((p) => p.slug === after);
        if (target && !target.installed) {
          recommended.push({ slug: after, version: target.version, reason: `loadAfter ${step.entry.slug}` });
        }
      }
    }
    const installed = installState();
    const installedNow = [];
    const skipped = [];
    let restartRequired = false;

    for (const step of steps) {
      const entry = step.entry;
      const source = sources().all.find((s) => s.id === entry.source_id) || null;
      if (!source || (!source.trustable && !sources().customUnlocked)) {
        throw new Error(`${entry.slug} 来自不受信任的源（${entry.source_name}），已拒绝安装`);
      }
      if (step.already) {
        skipped.push({ slug: entry.slug, version: entry.version, reason: '已安装同版本' });
        continue;
      }

      const { buf, from } = await packageBytes(entry);
      if (!buf || !buf.length) throw new Error(`${entry.slug} 的包是空的`);
      if (buf.length > MAX_PACKAGE_BYTES) throw new Error(`${entry.slug} 的包过大（${buf.length} 字节）`);

      const manifest = readManifestFromZip(buf);
      if (!manifest || typeof manifest !== 'object') throw new Error(`${entry.slug} 的 manifest 不可读`);
      if (String(manifest.slug || '') !== entry.slug) {
        // The slug is an identity, not a label: installing an archive that claims a different
        // slug is how one plugin silently replaces another one's settings.
        throw new Error(`${entry.slug} 的包声明 slug=${manifest.slug}，与索引不符，已拒绝安装`);
      }
      const digest = sha256(buf);
      const want = normaliseDigest(entry.sha256);
      if (want && want !== digest) {
        throw new Error(`${entry.slug} 的包 sha256 不匹配（索引 ${want.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`);
      }

      const fileName = safePackageName(entry.file || `${entry.slug}-${entry.version}.plugin`, entry.slug);
      mkdirSync(pluginsDir, { recursive: true });

      /* Themes are mutually exclusive, exactly as upstream treats them: two themes fight over the
       * same surfaces and the result is an unusable client.  The displacement happens AFTER the
       * new archive has been fetched and verified, so a mirror that fails mid-install cannot cost
       * the user the theme they already had. */
      if (String(entry.type || '') === 'theme') {
        for (const [otherSlug, have] of [...installed.entries()]) {
          if (otherSlug === entry.slug || !have.dir || !existsSync(have.dir)) continue;
          const other = aggregate.plugins.find((p) => p.slug === otherSlug);
          if (!other || String(other.type || '') !== 'theme') continue;
          const dest = join(data, '_uninstalled', stamp(), otherSlug);
          mkdirSync(dest, { recursive: true });
          renameSync(have.dir, join(dest, basename(have.dir)));
          installed.delete(otherSlug);
          log(`market: uninstalled theme ${otherSlug} (themes are exclusive)`);
        }
      }

      const staging = join(pluginsDir, `.bncm-tmp-${entry.slug}.plugin`);
      writeFileSync(staging, buf);
      const displaced = displaceInstalled(entry.slug, installed);
      const target = join(pluginsDir, fileName);
      renameSync(staging, target);
      installed.set(entry.slug, { version: entry.version, dir: target, disabled: false });

      if (manifest.require_restart === true || entry.require_restart === true) restartRequired = true;
      restartRequired = true;   // a newly installed script only runs after a page reload
      installedNow.push({
        slug: entry.slug, version: entry.version, file: fileName, bytes: buf.length,
        sha256: digest, source: entry.source_name, from, replaced: displaced,
        verified: !!want,
      });
      log(`market: installed ${entry.slug} ${entry.version} (${buf.length} bytes, ${from}`
          + `${want ? ', sha256 verified' : ''})`);
    }

    if (installedNow.length) onChange();
    return {
      ok: true, slug: String(slug), installed: installedNow, skipped, recommended,
      restart_required: restartRequired && installedNow.length > 0,
    };
  }

  /* --------------------------------------------------------------- preview ---- */

  /**
   * Preview images, resolved without making the page talk to a third party (the client's CSP and
   * the manager's own error reporting are both simpler when there is exactly one origin).
   */
  async function preview(entry) {
    if (!entry || !entry.preview) return null;
    const rel = String(entry.preview).replace(/\\/g, '/');
    if (rel.includes('..')) throw new Error('预览图路径不安全');
    const key = sha256(`${entry.source_id || ''}|${rel}`);

    if (entry.source_kind === 'builtin' && marketDir) {
      const full = join(marketDir, ...rel.split('/'));
      if (!existsSync(full)) return null;
      const buf = readFileSync(full);
      return { bytes: buf, type: contentTypeFor(rel) };
    }

    const cachedFile = join(previewCacheDir, key);
    if (existsSync(cachedFile)) {
      return { bytes: readFileSync(cachedFile), type: contentTypeFor(rel), cached: true };
    }
    if (offline || !entry.source_base) return null;

    const url = new URL(rel, entry.source_base.replace(/\/?$/, '/')).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res || !res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PREVIEW_BYTES) return null;
      try {
        mkdirSync(previewCacheDir, { recursive: true });
        writeFileSync(cachedFile, buf);
      } catch { /* a cache miss is not an error */ }
      return { bytes: buf, type: res.headers?.get?.('content-type') || contentTypeFor(rel) };
    } catch { return null; } finally { clearTimeout(timer); }
  }

  /* -------------------------------------------------------------- settings ---- */

  /** Upstream's market mirrors the selected source into BetterNCM's own config under
   *  `cc.microblock.pluginmarket.source`; third-party plugins read it back.  Keep the key and the
   *  format, and never fail the caller because a shared file could not be rewritten. */
  function mirrorSelectionToConfig(base) {
    try {
      const file = join(data, 'config.json');
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { cfg = {}; }
      if (typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
      cfg['cc.microblock.pluginmarket.source'] = base || '';
      writeFileSync(file, JSON.stringify(cfg), 'utf8');
    } catch (err) { log(`market: could not mirror the selected source to config.json: ${err.message}`); }
  }

  function updateSettings(patch = {}) {
    const st = readSettings();
    if (patch.selected !== undefined) {
      st.selected = patch.selected === null ? null : String(patch.selected);
    }
    if (patch.enabled && typeof patch.enabled === 'object') {
      // Stored explicitly, so "enable a source that ships disabled" survives the next read.
      for (const [id, value] of Object.entries(patch.enabled)) st.enabled[id] = value === true;
    }
    if (patch.custom_unlocked !== undefined) st.custom_unlocked = patch.custom_unlocked === true;
    if (patch.add_source && patch.add_source.base) {
      const base = String(patch.add_source.base).trim();
      if (!/^https?:\/\//i.test(base)) throw new Error('自定义源必须是 http(s) 地址');
      const id = customSourceId(base);
      if (!st.custom.some((c) => c.id === id)) {
        // A source the user typed in is untrusted by default: installing from it requires the
        // explicit unlock, exactly like upstream's `custom-source-unlocked-1` setting.
        st.custom.push({ id, base, name: String(patch.add_source.name || base).slice(0, 80),
                         trustable: patch.add_source.trustable === true });
      }
    }
    if (patch.remove_source) {
      st.custom = st.custom.filter((c) => c.id !== patch.remove_source && c.base !== patch.remove_source);
      delete st.enabled[patch.remove_source];
    }
    writeSettings(st);
    const resolved = sources();
    if (patch.selected !== undefined) {
      const chosen = resolved.all.find((s) => s.id === resolved.selected);
      mirrorSelectionToConfig(chosen ? chosen.base : '');
    }
    return resolved;
  }

  /** Drop caches (network index + previews).  Used by tests and by the UI's "强制刷新". */
  function clearCache() {
    memory.clear();
    rmSync(cacheDir, { recursive: true, force: true });
  }

  return {
    index,
    install,
    preview,
    sources,
    updateSettings,
    clearCache,
    readManifestFromZip,
    settingsFile,
    cacheDir,
    dirs: { data, pluginsDir, marketDir },
  };
}

export default createMarket;
