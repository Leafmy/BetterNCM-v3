/* bncm-harness.mjs -- a reusable fake client for loader/framework.js.
 *
 * Why a second harness
 * --------------------
 * test/framework-api.test.mjs already has a fake DOM, but it is built for CONTRACT tests: every
 * fetch resolves in the same microtask and `setTimeout` runs its callback inline.  That makes it
 * impossible to model the thing this harness exists for -- TIME.  A loader that loads plugins one
 * after another and a loader that loads them concurrently are indistinguishable when I/O is free.
 *
 * This harness therefore models the real shapes that make a loader scale badly:
 *
 *   - a per-request latency, so serialised I/O actually costs wall-clock time;
 *   - real timers, so AbortController timeouts and scheduler yields behave;
 *   - requests that never settle (a hung host) and requests that reject;
 *   - per-plugin/per-file script bodies, so a plugin can be made slow, noisy or broken.
 *
 * It is deliberately separate from the framework-api harness so that pinned regression suite keeps
 * its inline-timer semantics untouched.
 *
 * Only HOST APIs are injected into the vm context.  ECMAScript intrinsics (Promise, Object,
 * Function, Symbol, ...) must come from the vm realm itself: injecting this realm's versions makes
 * `new Function(...)` inside the framework build functions in THIS realm, where `window` does not
 * exist -- the documented failure mode that once made every plugin's onConfig throw.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const FRAMEWORK = readFileSync(resolve(REPO, 'loader', 'framework.js'), 'utf8');

/* ------------------------------------------------------------- fake DOM ---- */

export function makeElement(tag) {
  const el = {
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
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    replaceChildren() {},
    attachShadow() { return makeElement('shadow'); },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get outerHTML() { return this._html; },
    get isConnected() { return true; },
    get parentElement() { return null; },
    get nextElementSibling() { return null; },
  };
  return el;
}

/* -------------------------------------------------------------- entries ---- */

export function coreEntry(slug, extra = {}) {
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

export function userEntry(slug, extra = {}) {
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

/* ---------------------------------------------------------------- world ---- */

/**
 * Boot framework.js in a fake client.
 *
 * overrides:
 *   core / plugins          plugin entries served by GET /api/plugins
 *   latency                 default per-fetch latency in ms (default 0)
 *   scriptLatency(slug,f)   per script latency, overrides `latency`
 *   pluginCode(slug, file)  script body (default '/* plugin *\/')
 *   hang(slug, file)        return true to leave that request pending forever
 *   fail(slug, file)        return a status code to reject the request
 *   config                  extra window.__BNCM_CONFIG__ fields
 *   managersSource / devStatus / selectors / hijack as in framework-api.test.mjs
 *
 * Returns { win, doc, requests, context, dispose, setPlugins, stats() }.
 */
export function makeWorld(overrides = {}) {
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

  const requests = [];        // { url, method, at, settled, abortedMs }
  const localStore = new Map();
  // Exact in-flight accounting.  Computing "max concurrency" from [start, end] spans over-counts,
  // because the request that just settled and the one scheduled in its place overlap at the
  // boundary; a live counter is the only honest measure of how many downloads were open at once.
  const inflight = { all: 0, allMax: 0, script: 0, scriptMax: 0 };

  // Track every timer so a test can dispose the world and leave nothing running.
  const live = { timeouts: new Set(), intervals: new Set() };
  const ctxSetTimeout = (fn, ms) => {
    const h = setTimeout(() => { live.timeouts.delete(h); fn(); }, ms);
    live.timeouts.add(h);
    return h;
  };
  const ctxSetInterval = (fn, ms) => { const h = setInterval(fn, ms); live.intervals.add(h); return h; };
  const ctxClearInterval = (h) => { live.intervals.delete(h); clearInterval(h); };

  let plugins = overrides.plugins || [];
  let core = overrides.core || [];

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
    call(command, cb) { if (typeof cb === 'function') cb(undefined); },
    registerCall() {}, removeRegisterCall() {},
  };

  const jsonResponse = (data, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)),
  });
  const textResponse = (text, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(JSON.parse(text)), text: () => Promise.resolve(text),
  });

  function route(u) {
    if (u.indexOf('/api/plugins') !== -1) {
      return { kind: 'json', data: { plugins_dir: 'C:\\betterncm\\plugins', core_dir: 'core', plugins, core } };
    }
    if (u.indexOf('/api/selectors') !== -1) return { kind: 'json', data: overrides.selectors || { version: 1, builds: {} } };
    if (u.indexOf('/api/hijacks') !== -1) return { kind: 'json', data: { rules: overrides.hijackRules || [] } };
    if (u.indexOf('/manager.js') !== -1) {
      return { kind: 'text', text: overrides.managerSource ||
        'window.__BNCM_MANAGER__ = { install: function(){ window.__BNCM_MGR_INSTALLED__ = true; return true; } };' };
    }
    if (u.indexOf('/api/plugin/') !== -1) {
      const rest = u.split('/api/plugin/')[1].split('?')[0];
      const slash = rest.indexOf('/');
      const slug = decodeURIComponent(rest.slice(0, slash));
      const file = decodeURIComponent(rest.slice(slash + 1));
      if (overrides.hang && overrides.hang(slug, file)) return { kind: 'hang' };
      const status = overrides.fail ? overrides.fail(slug, file) : undefined;
      if (status) return { kind: 'json', data: { error: 'HTTP ' + status }, status };
      const code = overrides.pluginCode ? overrides.pluginCode(slug, file) : '/* plugin */';
      const ms = overrides.scriptLatency ? overrides.scriptLatency(slug, file)
        : (overrides.latency || 0);
      return { kind: 'text', text: code, latency: ms };
    }
    if (u.indexOf('/api/app/is_light_theme') !== -1) return { kind: 'json', data: false };
    if (u.indexOf('/api/log') !== -1) return { kind: 'json', data: { ok: true } };
    if (u.indexOf('/api/dev/status') !== -1) {
      const s = typeof overrides.devStatus === 'function' ? overrides.devStatus() : overrides.devStatus;
      if (!s) return { kind: 'json', data: {}, status: 404 };
      return { kind: 'json', data: s };
    }
    if (u.indexOf('/api/dev/') !== -1) {
      return { kind: 'json', data: overrides.devResponse || { ok: true, watching: true, interval_ms: 1000, sources: [], hooks: [], generation: 0 } };
    }
    return { kind: 'json', data: {}, status: 404 };
  }

  win.fetch = function (url, opts) {
    const u = String(url);
    const rec = { url: u, method: (opts && opts.method) || 'GET', at: Date.now(), settled: false, abortedMs: null };
    requests.push(rec);
    const r = route(u);
    const isScript = u.indexOf('/api/plugin/') !== -1;
    inflight.script = isScript ? inflight.script + 1 : inflight.script;
    inflight.all++;
    if (isScript && inflight.script > inflight.scriptMax) inflight.scriptMax = inflight.script;
    if (inflight.all > inflight.allMax) inflight.allMax = inflight.all;
    const settle = () => { inflight.all--; if (isScript) inflight.script--; };

    const signal = opts && opts.signal;
    const latency = r.latency || 0;
    const respond = () => {
      rec.settled = true;
      rec.settledAt = Date.now();
      if (r.kind === 'text') return textResponse(r.text, r.status || 200);
      return jsonResponse(r.data, r.status || 200);
    };
    return new Promise((resolvePromise, rejectPromise) => {
      let done = false;
      // A server that never answers must still honour an abort: that is exactly how a real fetch
      // behaves, and it is what turns AbortController into a working load deadline.
      if (r.kind === 'hang') {
        if (signal) {
          const onAbort = () => {
            if (done) return;
            done = true;
            rec.settled = true; rec.settledAt = Date.now(); rec.abortedMs = Date.now() - rec.at;
            settle();
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            rejectPromise(err);
          };
          if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort);
        }
        return;   // otherwise: pending forever, and still counted as in flight
      }
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        live.timeouts.delete(timer);
        settle();
        resolvePromise(respond());
      }, latency);
      live.timeouts.add(timer);
      if (signal) {
        const onAbort = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          live.timeouts.delete(timer);
          rec.settled = true;
          rec.abortedMs = Date.now() - rec.at;
          rec.settledAt = Date.now();
          settle();
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          rejectPromise(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      }
    });
  };

  const ctx = {
    window: win, document: doc,
    location: { href: 'orpheus://orpheus/pub/app.html', reload() { win.__RELOADED__ = (win.__RELOADED__ || 0) + 1; } },
    console, fetch: win.fetch, localStorage: win.localStorage,
    URL, EventTarget, AbortController, performance, MessageChannel,
    CustomEvent: class CustomEvent extends Event {
      constructor(type, init) { super(type); this.detail = init && init.detail; }
    },
    setInterval: ctxSetInterval, clearInterval: ctxClearInterval,
    setTimeout: ctxSetTimeout, clearTimeout: (h) => { live.timeouts.delete(h); clearTimeout(h); },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  win.document = doc;
  win.console = console;
  win.setInterval = ctx.setInterval; win.clearInterval = ctx.clearInterval;
  win.setTimeout = ctx.setTimeout; win.clearTimeout = ctx.clearTimeout;
  win.EventTarget = EventTarget;
  win.CustomEvent = ctx.CustomEvent;
  win.addEventListener = () => {};
  win.__BNCM_CONFIG__ = Object.assign({ api: 'http://127.0.0.1:5555', key: 'k' }, overrides.config || {});
  win.__BNCM_PRELOAD__ = 'bncm-v3-preload/test';
  win.__BNCM_HIJACK__ = overrides.hijack || {
    build: 'test', hooksInstalled: true, rulesReady: true, rulesLoaded: 1,
    jsonpPayloads: 3, modulesSeen: 9, modulesRewritten: 1, bufferedPayloads: 0, rulesLate: false,
    applied: [], missed: [], errors: [], checkMissed() { return []; },
  };
  if (overrides.withWebpack !== false) {
    win.__BNCM_WP__ = {
      require: Object.assign(function () {}, { c: {} }),
      cache: {}, modules: {},
    };
  }

  const context = vm.createContext(ctx);
  vm.runInContext(FRAMEWORK, context, { filename: 'framework.js' });

  const world = {
    win, doc, requests, context, inflight,
    setPlugins(next) { plugins = next.plugins || plugins; core = next.core || core; },
    dispose() {
      for (const h of live.intervals) clearInterval(h);
      for (const h of live.timeouts) clearTimeout(h);
      live.intervals.clear(); live.timeouts.clear();
    },
    stats() { return win.__BNCM_LOADED__ && win.__BNCM_LOADED__.perf; },
  };
  return world;
}

/** Wait until `cond()` is true, or fail after `timeoutMs`. */
export function waitFor(cond, timeoutMs = 4000, stepMs = 5) {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    const tick = () => {
      let v = false;
      try { v = cond(); } catch { v = false; }
      if (v) return resolvePromise(v);
      if (Date.now() - start > timeoutMs) return rejectPromise(new Error('waitFor timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/** Wait until the loader reports `count` plugins in a TERMINAL state (loaded|error|skipped).
 *  The loader publishes this snapshot incrementally, so progress is observable while it runs. */
export function waitForPlugins(world, count, timeoutMs = 8000) {
  return waitFor(() => {
    const p = world.win.__BNCM_LOADED__ && world.win.__BNCM_LOADED__.plugins;
    if (!p) return false;
    const done = p.filter((x) => x.state === 'loaded' || x.state === 'error' || x.state === 'skipped').length;
    return done >= count;
  }, timeoutMs);
}

export function bySlug(list) {
  const out = {};
  for (const p of list || []) out[p.slug] = p;
  return out;
}

export function fmt(ms) { return `${Math.round(ms * 100) / 100}ms`; }
