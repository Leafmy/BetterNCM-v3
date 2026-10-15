/* plugin-ordering.test.mjs -- dependency ordering must survive the REAL host path.
 *
 * The bug this pins
 * -----------------
 * tools/ncm_host.mjs#normaliseManifest() rebuilt every manifest from a fixed key set, so
 * `loadAfter` and `requirements` never reached the page.  framework.js#orderPlugins() then read
 * `undefined` and the ordering pass was a silent no-op -- plugins loaded in directory order.
 *
 * framework-api.test.mjs could not catch this: it builds its own manifest objects and never calls
 * normaliseManifest(), so ordering looked fine while it was dead in the real host.
 *
 * This test therefore goes through discoverPlugins() over real files on disk, then feeds the
 * host's exact /api/plugins payload into framework.js and asserts the resulting load order.
 *
 * Run: node test/plugin-ordering.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { discoverPlugins } from '../tools/ncm_host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FRAMEWORK = readFileSync(resolve(REPO, 'loader', 'framework.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
const settle = () => new Promise((r) => setTimeout(r, 0));
function eqArr(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b),
     `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}
async function waitFor(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await settle();
  }
  return fn();
}

/* ------------------------------------------------------------- fake DOM ---- */

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {}, children: [], attrs: {}, dataset: {}, _text: '', _html: '',
    className: '', id: '', title: '', href: '', hidden: false,
    classList: {
      _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    replaceChildren() {},
    attachShadow() { return makeElement('shadow'); },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get outerHTML() { return this._html; },
    get isConnected() { return true; },
    get parentElement() { return null; },
    get nextElementSibling() { return null; },
  };
}

function makeWorld(overrides = {}) {
  const el = makeElement;
  const body = el('body');
  const head = el('head');
  const doc = {
    readyState: 'complete',
    head, body, documentElement: el('html'),
    createElement: (t) => el(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    title: '网易云音乐',
  };

  const localStore = new Map();
  const win = {};
  win.localStorage = {
    getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: (k) => localStore.delete(k),
  };
  win.React = { createElement() {}, Fragment: Symbol('Fragment') };
  win.ReactDOM = { render() {}, unmountComponentAtNode() {} };
  win.APP_CONF = overrides.appConf === undefined ? { appver: '3.1.41.205529' } : overrides.appConf;
  win.navigator = overrides.navigator === undefined
    ? { userAgent: 'Mozilla/5.0 ... Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529' }
    : overrides.navigator;
  win.legacyNativeCmder = { appendRegisterCall() {}, removeRegisterCall() {} };
  win.channel = {
    call(command, cb) { cb(undefined); },
    registerCall() {}, removeRegisterCall() {},
  };

  const plugins = overrides.plugins || [];
  const core = overrides.core || [];
  const jsonFetch = (data) => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });

  win.fetch = async function (url) {
    const u = String(url);
    if (u.indexOf('/api/plugins') !== -1) {
      return jsonFetch({ plugins_dir: 'C:\\betterncm\\plugins', core_dir: 'core', plugins, core });
    }
    if (u.indexOf('/api/selectors') !== -1) return jsonFetch({ version: 1, builds: {} });
    if (u.indexOf('/api/hijacks') !== -1) return jsonFetch({ rules: [] });
    if (u.indexOf('/manager.js') !== -1) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(
        'window.__BNCM_MANAGER__ = { install: function(){ return true; } };') });
    }
    if (u.indexOf('/api/plugin/') !== -1) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('/* plugin */') });
    }
    if (u.indexOf('/api/app/is_light_theme') !== -1) return jsonFetch(false);
    if (u.indexOf('/api/log') !== -1) return jsonFetch({ ok: true });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}),
                             text: () => Promise.resolve('') });
  };

  const ctx = {
    window: win, document: doc, location: { href: 'orpheus://orpheus/pub/app.html', reload() {} },
    console, fetch: win.fetch, localStorage: win.localStorage, URL, EventTarget,
    CustomEvent: class CustomEvent extends Event {
      constructor(type, init) { super(type); this.detail = init && init.detail; }
    },
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: (fn) => { try { fn(); } catch (e) { /* ignore */ } return 1; },
    clearTimeout: () => {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  win.document = doc;
  win.console = console;
  win.Promise = Promise;
  win.setInterval = ctx.setInterval; win.clearInterval = ctx.clearInterval;
  win.setTimeout = ctx.setTimeout; win.clearTimeout = ctx.clearTimeout;
  win.EventTarget = EventTarget;
  win.CustomEvent = ctx.CustomEvent;
  win.addEventListener = () => {};
  win.__BNCM_CONFIG__ = { api: 'http://127.0.0.1:5555', key: 'k' };
  win.__BNCM_PRELOAD__ = 'bncm-v3-preload/test';
  win.__BNCM_HIJACK__ = {
    build: 'test', hooksInstalled: true, rulesReady: true, rulesLoaded: 0,
    jsonpPayloads: 0, modulesSeen: 0, modulesRewritten: 0, bufferedPayloads: 0, rulesLate: false,
    applied: [], missed: [], errors: [], checkMissed() { return []; },
  };
  if (overrides.withWebpack !== false) {
    win.__BNCM_WP__ = { require: Object.assign(function () {}, { c: {} }), cache: {}, modules: {} };
  }

  const context = vm.createContext(ctx);
  vm.runInContext(FRAMEWORK, context, { filename: 'framework.js' });
  return { win };
}

/* ------------------------------------------------- fixture: real files ---- */

/* Dependency chain is Player <- Theme <- Lyric, but the DIRECTORY names sort the other way
 * round, so alphabetical (host) order is exactly wrong and only real ordering fixes it:
 *
 *   host order       : ALyric, MTheme, ZPlayer     (locateCompare on dir name)
 *   required order   : ZPlayer, MTheme, ALyric
 */
const FIXTURE = {
  ZPlayer: { version: '1.0.0', author: 't', description: 'base player',
             author_links: ['https://github.com/example'], preview: 'preview.png',
             source: { repo: 'https://example.invalid/player', license: 'MIT' } },
  MTheme:  { loadAfter: ['ZPlayer'], version: '1.0.0', author: 't' },
  ALyric:  { requirements: ['MTheme'], loadAfter: ['MTheme'], version: '1.0.0', author: 't',
             incompatible: ['Apple-Musiclike-lyrics'] },
};

function writeFixture(dir) {
  for (const [slug, extra] of Object.entries(FIXTURE)) {
    const d = join(dir, slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'manifest.json'), JSON.stringify(Object.assign({
      manifest_version: 1, name: slug, slug, type: 'extension',
      'ncm3-compatible': true, injects: { Main: [{ file: 'index.js' }] },
    }, extra), null, 2));
    writeFileSync(join(d, 'index.js'), '/* fixture */\n');
  }
}

/** Mirror of the real host's /api/plugins entry shape. */
const shape = (p) => ({
  dir: p.dir, kind: p.kind, error: p.error || null, manifest: p.manifest,
  core: false, locked: false, lock_reason: null, disabled: false,
});

/* ---------------------------------------------------------------- tests ---- */

async function main() {
  console.log('plugin ordering (real host path)');
  const tmp = mkdtempSync(join(tmpdir(), 'bncm-order-'));
  try {
    writeFixture(tmp);

    // --- A. normaliseManifest must not drop dependency / metadata fields ------
    const discovered = discoverPlugins(tmp);
    const byslug = Object.fromEntries(discovered.map((p) => [p.manifest.slug, p.manifest]));

    eqArr('host sees all three fixture plugins',
          discovered.map((p) => p.manifest.slug), ['ALyric', 'MTheme', 'ZPlayer']);
    eqArr('A: loadAfter survives normaliseManifest',
          byslug.MTheme.loadAfter, ['ZPlayer']);
    eqArr('A: requirements survives normaliseManifest',
          byslug.ALyric.requirements, ['MTheme']);
    eqArr('A: loadAfter survives alongside requirements',
          byslug.ALyric.loadAfter, ['MTheme']);
    eqArr('A: incompatible survives normaliseManifest',
          byslug.ALyric.incompatible, ['Apple-Musiclike-lyrics']);
    eqArr('A: author_links survives normaliseManifest',
          byslug.ZPlayer.author_links, ['https://github.com/example']);
    ok('A: preview survives normaliseManifest',
       byslug.ZPlayer.preview === 'preview.png', String(byslug.ZPlayer.preview));
    ok('A: source survives normaliseManifest',
       !!byslug.ZPlayer.source && byslug.ZPlayer.source.license === 'MIT');
    eqArr('A: absent dependency lists normalise to []',
          byslug.ZPlayer.loadAfter, []);

    // --- B. the loader must actually reorder them ----------------------------
    const w = makeWorld({ plugins: discovered.map(shape) });
    const loaded = await waitFor(() => {
      const l = w.win.__BNCM_LOADED__;
      return (l && Array.isArray(l.plugins) && l.plugins.length === 3) ? l : null;
    });
    eqArr('B: plugins load in dependency order, not directory order',
          loaded.plugins.map((p) => p.slug), ['ZPlayer', 'MTheme', 'ALyric']);
    eqArr('B: every fixture plugin loaded',
          loaded.plugins.filter((p) => p.state === 'loaded').map((p) => p.slug),
          ['ZPlayer', 'MTheme', 'ALyric']);

    // --- C. betterncm.status().ncmVersionUnverified must reflect reality -----
    const known = makeWorld({ plugins: discovered.map(shape) });
    await waitFor(() => known.win.__BNCM_LOADED__ && known.win.__BNCM_LOADED__.plugins);
    await settle(); await settle();
    const statusKnown = known.win.betterncm && known.win.betterncm.status
      ? known.win.betterncm.status() : null;
    ok('C: status() is reachable', !!statusKnown);
    ok('C: a detectable client version reports ncmVersionUnverified === false',
       !!(statusKnown && statusKnown.ncmVersionUnverified === false),
       JSON.stringify(statusKnown && statusKnown.ncmVersionUnverified));

    // Unknown version: no APP_CONF and a User-Agent without the desktop token, and no
    // previous-run record, so detection fails and every version-gated plugin is marked.
    const unknown = makeWorld({
      appConf: null,
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0' },
      plugins: discovered.map(shape),
    });
    const uLoaded = await waitFor(() => {
      const l = unknown.win.__BNCM_LOADED__;
      return (l && Array.isArray(l.plugins) && l.plugins.length === 3) ? l : null;
    });
    await settle(); await settle();
    const marked = uLoaded.plugins.filter((p) => p.ncm_version_unverified).map((p) => p.slug);
    ok('C: unknown version marks the per-plugin record', marked.length > 0, JSON.stringify(marked));
    const statusUnknown = unknown.win.betterncm.status();
    ok('C: status().ncmVersionUnverified is true when the version is unknown',
       statusUnknown.ncmVersionUnverified === true,
       JSON.stringify(statusUnknown.ncmVersionUnverified));
    ok('C: status().ncmVersion is null in that case',
       statusUnknown.ncmVersion === null, JSON.stringify(statusUnknown.ncmVersion));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
