/* framework-api.test.mjs -- smoke-test loader/framework.js without the client.
 *
 * Why this exists
 * ---------------
 * The framework is the contract every plugin talks to, and the 0.3.0 revision changed several
 * of its promises: loadedPlugins gained slug-keyed access, ncm.getPlaying() became synchronous,
 * getSucceededHijacks() stopped returning null, notSupported() became type-aware, core plugins
 * started bypassing the 3.x gate, and plugin.onConfig finally runs.  None of that can be
 * verified by reading, and the client cannot be started from here.
 *
 * So the framework is executed against a minimal fake DOM and a stub backend, and the assertions
 * below pin exactly the behaviours that were broken before (each one is a bug that was observed
 * in the real client or in docs/real-plugin-compat.json).
 *
 * Run: node test/framework-api.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FRAMEWORK = readFileSync(resolve(REPO, 'loader', 'framework.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
const settle = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------- fake DOM ---- */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {}, children: [], attrs: {}, dataset: {}, _text: '', _html: '',
    className: '', id: '', title: '', href: '', hidden: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
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
  return el;
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

  const calls = [];          // every window.channel.call
  const requests = [];       // every fetch URL
  const localStore = new Map();

  const win = {};
  win.localStorage = {
    getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: (k) => localStore.delete(k),
  };
  // The client exposes React/ReactDOM globally; the framework's React shim waits on React.
  win.React = { createElement() {}, Fragment: Symbol('Fragment') };
  win.ReactDOM = { render() {}, unmountComponentAtNode() {} };
  // `appConf: null` models the REAL 3.1.41 client, where window.APP_CONF is undefined and the
  // version is only available from the User-Agent.
  win.APP_CONF = overrides.appConf === undefined ? { appver: '3.1.41.205529' } : overrides.appConf;
  win.navigator = overrides.navigator === undefined
    ? { userAgent: 'Mozilla/5.0 ... Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529' }
    : overrides.navigator;
  win.legacyNativeCmder = { appendRegisterCall() {}, removeRegisterCall() {} };
  win.channel = {
    call(command, cb, args) { calls.push({ command, args }); cb(undefined); },
    registerCall() {}, removeRegisterCall() {},
  };

  const plugins = overrides.plugins || [];
  const core = overrides.core || [];

  function jsonFetch(data) { return Promise.resolve({ ok: true, json: () => Promise.resolve(data) }); }

  win.fetch = async function (url, opts) {
    const u = String(url);
    requests.push({ url: u, method: (opts && opts.method) || 'GET' });
    if (u.indexOf('/api/plugins') !== -1) {
      return jsonFetch({ plugins_dir: 'C:\\betterncm\\plugins', core_dir: 'core',
                         plugins, core });
    }
    if (u.indexOf('/api/selectors') !== -1) {
      return jsonFetch(overrides.selectors || { version: 1, builds: {} });
    }
    if (u.indexOf('/api/hijacks') !== -1) {
      return jsonFetch({ rules: overrides.hijackRules || [] });
    }
    if (u.indexOf('/manager.js') !== -1) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(overrides.managerSource ||
        'window.__BNCM_MANAGER__ = { install: function(b,h){ window.__BNCM_MGR_INSTALLED__ = true; return true; } };') });
    }
    if (u.indexOf('/api/plugin/') !== -1) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(overrides.pluginSource || '/* plugin */') });
    }
    if (u.indexOf('/api/app/is_light_theme') !== -1) return jsonFetch(false);
    if (u.indexOf('/api/log') !== -1) return jsonFetch({ ok: true });
    if (u.indexOf('/api/dev/status') !== -1) {
      const s = typeof overrides.devStatus === 'function' ? overrides.devStatus() : overrides.devStatus;
      // Default: model an OLD host with no dev endpoints at all.  Dev tooling must degrade to
      // "disabled" rather than throwing into the boot path.
      if (!s) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      return jsonFetch(s);
    }
    if (u.indexOf('/api/dev/') !== -1) {
      return jsonFetch(overrides.devResponse || {
        ok: true, watching: true, interval_ms: 1000, sources: [], hooks: [], generation: 0,
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  };

  // NOTE: only HOST APIs are injected here.  ECMAScript intrinsics (Function, Object, Promise,
  // Symbol, ...) must be left to the vm realm: injecting the outer realm's versions shadows the
  // sandbox's own and makes `new Function(...)` inside the framework create functions in THIS
  // realm, where `window` does not exist -- which is exactly how a plugin's onConfig callback
  // ended up throwing "window is not defined".
  const ctx = {
    window: win, document: doc, location: { href: 'orpheus://orpheus/pub/app.html', reload() {} },
    console, fetch: win.fetch, localStorage: win.localStorage,
    URL,
    EventTarget,
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
  // Simulate the document-start preload having run.
  win.__BNCM_PRELOAD__ = 'bncm-v3-preload/test';
  win.__BNCM_HIJACK__ = overrides.hijack || {
    build: 'test', hooksInstalled: true, rulesReady: true, rulesLoaded: 1,
    jsonpPayloads: 3, modulesSeen: 9, modulesRewritten: 1, bufferedPayloads: 0, rulesLate: false,
    applied: [{ id: 'RefinedNowPlaying::module:lyrics-pipeline', slug: 'RefinedNowPlaying', moduleId: '42', replacements: 1 }],
    missed: [], errors: [], checkMissed() { return []; },
  };
  if (overrides.withWebpack !== false) {
    win.__BNCM_WP__ = {
      require: Object.assign(function () {}, { c: { 1: { exports: { getPlaying: () => ({ id: 777, title: 'T', type: 1 }) } } } }),
      cache: { 1: { exports: { getPlaying: () => ({ id: 777, title: 'T', type: 1 }) } } },
      modules: {},
    };
  }

  const context = vm.createContext(ctx);
  vm.runInContext(FRAMEWORK, context, { filename: 'framework.js' });

  return { win, doc, calls, requests, context, localStore };
}

function coreEntry(slug, extra = {}) {
  return {
    dir: 'plugins\\core\\' + slug, kind: 'dir', error: null, core: true, locked: true,
    lock_reason: 'built-in plugin shipped with the loader', disabled: false,
    manifest: Object.assign({
      slug, name: slug, version: '1.0.0', author: 'a', type: 'extension',
      manifest_version: 1, ncm_version_req: '> 2.10.2', ncm3_compatible: null,
      injects: { Main: [{ file: 'main.js' }] }, hijacks: {},
    }, extra.manifest || {}),
  };
}

function userEntry(slug, extra = {}) {
  return Object.assign({
    dir: 'C:\\betterncm\\plugins\\' + slug + '.plugin', kind: 'zip', error: null,
    core: false, locked: false, lock_reason: null, disabled: !!extra.disabled,
    manifest: Object.assign({
      slug, name: slug, version: '9.9.9', author: 'b', type: 'extension',
      manifest_version: 1, ncm_version_req: '> 2.10.2', ncm3_compatible: null,
      injects: { Main: [{ file: 'main.js' }] }, hijacks: {},
    }, extra.manifest || {}),
  }, extra.entry || {});
}

/* ---------------------------------------------------------------- tests ---- */

async function main() {
  console.log('framework api');

  // --- A. core loads first, gate bypassed, and stays locked -------------------
  {
    const w = makeWorld({
      core: [coreEntry('RefinedNowPlaying'), coreEntry('LyricBar'), coreEntry('MaterialYouTheme')],
      // a user plugin that declares ncm3-compatible:false must still be skipped
      plugins: [userEntry('Incompatible', { manifest: { ncm3_compatible: false } }),
                userEntry('Disabled', { disabled: true })],
    });
    await settle(); await settle(); await settle();

    const loaded = w.win.__BNCM_LOADED__;
    ok('framework booted', !!loaded && !!loaded.build);
    eq('build is 0.4.0', w.win.__BNCM_FRAMEWORK__, 'bncm-v3-framework/0.4.0');

    const byslug = {};
    (loaded.plugins || []).forEach((p) => { byslug[p.slug] = p; });
    eq('core RefinedNowPlaying loaded', byslug.RefinedNowPlaying && byslug.RefinedNowPlaying.state, 'loaded');
    eq('core LyricBar loaded', byslug.LyricBar && byslug.LyricBar.state, 'loaded');
    eq('core MaterialYouTheme loaded', byslug.MaterialYouTheme && byslug.MaterialYouTheme.state, 'loaded');
    eq('core plugin is marked core', byslug.RefinedNowPlaying.core, true);
    eq('incompatible user plugin skipped', byslug.Incompatible && byslug.Incompatible.state, 'skipped');
    eq('disabled user plugin skipped', byslug.Disabled && byslug.Disabled.state, 'skipped');

    const order = (loaded.plugins || []).filter((p) => p.state === 'loaded' && p.core).map((p) => p.slug);
    eq('core plugins loaded before user plugins', order.length, 3);

    // --- B. loadedPlugins must be array-like AND slug-addressable -------------
    const lp = w.win.loadedPlugins;
    ok('loadedPlugins is array-like', typeof lp.length === 'number' && Array.isArray(lp));
    ok('loadedPlugins.MaterialYouTheme resolves (LyricBar probes it)',
       !!(lp.MaterialYouTheme && lp.MaterialYouTheme.manifest), String(lp.MaterialYouTheme));
    eq('loadedPlugins.RefinedNowPlaying.manifest.version (RNP probes it)',
       lp.RefinedNowPlaying && lp.RefinedNowPlaying.manifest.version, '1.0.0');

    // --- C. ncm.getPlaying() is synchronous and never null --------------------
    const playing = w.win.betterncm.ncm.getPlaying();
    eq('getPlaying returns synchronously', playing && playing.id, 777);

    // --- D. getSucceededHijacks returns an ARRAY (RNP calls .filter on it) ----
    const hj = await w.win.betterncm.app.getSucceededHijacks();
    ok('getSucceededHijacks is an array', Array.isArray(hj), JSON.stringify(hj));
    ok('it reports the applied hijack', hj.some((x) => x.indexOf('RefinedNowPlaying') !== -1), JSON.stringify(hj));

    // --- E. app.exec opens URLs instead of refusing ---------------------------
    w.calls.length = 0;
    await w.win.betterncm.app.exec('https://github.com/solstice23');
    ok('app.exec used the native opener',
       w.calls.some((c) => c.command === 'os.navigateExternal'), JSON.stringify(w.calls));

    // --- F. notSupported returns a type-appropriate empty ---------------------
    const shot = await w.win.betterncm.app.takeBackgroundScreenshot();
    eq('a stub returns null where null is the documented value', shot, null);
  }

  // --- G. plugin.onConfig actually runs ---------------------------------------
  {
    const w = makeWorld({
      core: [coreEntry('LyricBar')],
      // a plugin that registers a config view; the OLD framework never dispatched `config`,
      // so hooks.onConfig was false for all 22 real plugins.
      pluginSource: [
        'plugin.onConfig(function (toolbox) {',
        '  window.__CONFIG_RAN__ = (window.__CONFIG_RAN__ || 0) + 1;',
        '  return document.createElement("div");',
        '});',
      ].join('\n'),
    });
    await settle(); await settle(); await settle();
    eq('plugin.onConfig ran', w.win.__CONFIG_RAN__, 1);
    const entry = w.win.__BNCM_LOADED__.plugins.filter((p) => p.slug === 'LyricBar')[0];
    eq('onConfig hook reported truthfully', entry.hooks.onConfig, true);
  }

  // --- H. the injector diagnostics are populated ------------------------------
  {
    const w = makeWorld({ core: [coreEntry('LyricBar')] });
    await settle(); await settle(); await settle();
    const inj = w.win.betterncm.injector;
    ok('injector state exists', !!inj);
    eq('preload version surfaced', inj.preload, 'bncm-v3-preload/test');
    eq('webpack state surfaced', inj.webpack, 'captured');
    eq('react global surfaced', inj.react, 'object');
    eq('legacyNativeCmder surfaced', inj.legacyNativeCmder, true);
  }

  // --- I. no webpack capture: findApiFunction degrades, getPlaying still shaped -
  {
    const w = makeWorld({ core: [coreEntry('LyricBar')], withWebpack: false });
    await settle(); await settle(); await settle();
    const p = w.win.betterncm.ncm.getPlaying();
    ok('getPlaying still returns a shaped object', p && typeof p.id === 'string', JSON.stringify(p));
    w.calls.length = 0;
    await w.win.betterncm.ncm.getPlayingSong();
    ok('getPlayingSong still reaches the bridge',
       w.calls.some((c) => c.command === 'player.getPlayingSong'), JSON.stringify(w.calls));
  }

  // --- J. selector registry merges host data over the built-in fallbacks -------
  {
    const w = makeWorld({
      core: [coreEntry('LyricBar')],
      selectors: { version: 7, builds: { '3.1.41': { settingsButton: '#my-settings' } } },
    });
    await settle(); await settle(); await settle();
    eq('host selector used', w.win.betterncm.dom.selector('settingsButton'), '#my-settings');
    ok('built-in fallbacks still present for other keys',
       !!w.win.betterncm.dom.selector('playerBar'));
  }

  // --- K. version detection and the fail-open gate -----------------------------
  // Measured on the live client: window.APP_CONF is UNDEFINED on 3.1.41, so the old detector
  // returned null and `satisfies(null, '> 3.0.0')` silently skipped every version-constrained
  // plugin (reported as "not satisfied by null").
  {
    const w = makeWorld({
      appConf: null,                                  // the real client's shape
      navigator: { userAgent: 'Mozilla/5.0 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529' },
      core: [coreEntry('LyricBar')],
      plugins: [userEntry('NeedsNewClient', { manifest: { ncm_version_req: '> 3.1.11' } })],
    });
    await settle(); await settle(); await settle();
    eq('the client version comes from the User-Agent', w.win.betterncm.ncm.getNCMVersion(), '3.1.41.205529');
    const byslug = {};
    (w.win.__BNCM_LOADED__.plugins || []).forEach((p) => { byslug[p.slug] = p; });
    eq('a version-constrained plugin loads on the real client shape',
       byslug.NeedsNewClient && byslug.NeedsNewClient.state, 'loaded');
    eq('loadedPlugins report the detected version too',
       w.win.__BNCM_LOADED__.appver, '3.1.41.205529');
  }

  // --- L. an UNKNOWN version must not fail closed ------------------------------
  {
    const w = makeWorld({
      appConf: null,
      navigator: { userAgent: 'Mozilla/5.0 Chrome/91.0.4472.164' },   // no NeteaseMusicDesktop tag
      core: [coreEntry('LyricBar')],
      plugins: [userEntry('UnknownVersion', { manifest: { ncm_version_req: '> 99.0.0' } })],
    });
    await settle(); await settle(); await settle();
    const byslug = {};
    (w.win.__BNCM_LOADED__.plugins || []).forEach((p) => { byslug[p.slug] = p; });
    eq('an undetectable version does not skip the plugin',
       byslug.UnknownVersion && byslug.UnknownVersion.state, 'loaded');
    ok('and the plugin is marked unverified',
       !!byslug.UnknownVersion.ncm_version_unverified);
  }

  // --- M. a KNOWN version still enforces the requirement ----------------------
  {
    const w = makeWorld({
      appConf: { appver: '3.1.41.205529' },
      core: [coreEntry('LyricBar')],
      plugins: [userEntry('TooNew', { manifest: { ncm_version_req: '> 99.0.0' } })],
    });
    await settle(); await settle(); await settle();
    const byslug = {};
    (w.win.__BNCM_LOADED__.plugins || []).forEach((p) => { byslug[p.slug] = p; });
    eq('a known version still skips an unsatisfiable requirement',
       byslug.TooNew && byslug.TooNew.state, 'skipped');
  }

  // --- N. dev mode -----------------------------------------------------------
  //  An old host has no /api/dev/* at all; every dev call must fail soft, because dev tooling
  //  must never be able to break a normal session.
  {
    const w = makeWorld({ core: [coreEntry('LyricBar')] });
    await settle(); await settle(); await settle();
    const dev = w.win.betterncm.dev;
    ok('betterncm.dev exists even without a dev-capable host', !!dev);
    eq('... and reports itself disabled', dev.enabled, false);
    ok('... with a reason recorded', typeof dev.error === 'string' && dev.error.length > 0);
    eq('a normal plugin is not in devMode', w.win.betterncm.plugin.get('LyricBar').devMode, false);
    const r = await dev.reload();
    ok('dev.reload() still re-runs the loader', r.reloads >= 1);
  }

  //  A dev-capable host: sources, a dev-sourced plugin, and the generation-based hot reload.
  {
    let gen = 5;
    const w = makeWorld({
      core: [coreEntry('LyricBar')],
      plugins: [userEntry('DevOne', { entry: { dev: true, dev_source: 's1' } })],
      devStatus: () => ({
        enabled: true, generation: gen, watching: false, interval_ms: 3000,
        last_change_at: '2026-01-01T00:00:00Z',
        last_change: { why: 'source changed', sources: ['s1'] },
        sources: [{ id: 's1', input: 'C:\\src\\DevOne', type: 'dir', error: null,
                    plugin: { slug: 'DevOne', name: 'DevOne', version: '0.0.1' } }],
        hooks: [{ id: 'probe', type: 'replace' }],
        plugins: [{ slug: 'DevOne', version: '0.0.1', dir: 'C:\\src\\DevOne' }],
      }),
    });
    await settle(); await settle(); await settle(); await settle();
    const dev = w.win.betterncm.dev;
    eq('dev is enabled when the host says so', dev.enabled, true);
    eq('dev mirrors the generation', dev.generation, 5);
    eq('dev mirrors the dev sources', dev.sources.length, 1);
    eq('dev mirrors the ad-hoc hooks', dev.hooks.length, 1);

    const ctx = w.win.betterncm.plugin.get('DevOne');
    eq('a dev-sourced plugin sees devMode true', ctx.devMode, true);
    eq('... and so does its mainPlugin', ctx.mainPlugin.devMode, true);
    eq('while an installed plugin stays false', w.win.betterncm.plugin.get('LyricBar').devMode, false);
    eq('dev.plugins(slug) reports where it came from', dev.plugins('DevOne').dev_source, 's1');
    eq('dev.hook.applied() reads the preload state', dev.hook.applied().applied.length, 1);
    eq('dev.log() reports success', dev.log('hello'), true);
    eq('dev.assert() returns the verdict', dev.assert('sanity', true), true);
    eq('dev.inspect() is safe on a fake DOM', dev.inspect('.x').count, 0);

    let reloads = 0;
    const off = dev.on('reload', () => { reloads++; });
    await dev.watch(true);
    ok('dev.watch() talks to the host',
       w.requests.some((r) => r.url.indexOf('/api/dev/watch') !== -1 && r.method === 'POST'));
    await dev.addSource('acme/x#dev');
    ok('dev.addSource() talks to the host',
       w.requests.some((r) => r.url.indexOf('/api/dev/sources/add') !== -1));
    await dev.hook.add({ id: 'x', from: 'a', to: 'b' });
    ok('dev.hook.add() talks to the host',
       w.requests.some((r) => r.url.indexOf('/api/dev/hooks/add') !== -1));

    // The generation counter IS the hot-reload signal: the page polls it and re-runs the loader.
    gen = 6;
    const refreshed = await dev.refresh();
    eq('a generation bump is detected', refreshed.changed, true);
    eq('... and reloads the plugin list', dev.reloads, 1);
    eq('... notifying dev.on("reload") listeners', reloads, 1);
    eq('no bump, no reload', (await dev.refresh()).changed, false);
    eq('... reloads stayed put', dev.reloads, 1);
    off();
  }

  await settle();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
