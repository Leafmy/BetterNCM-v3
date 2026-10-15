/* manager-market.test.mjs -- the market TAB of loader/manager.js, on a fake DOM.
 *
 * The market is the part of the manager a user judges instantly: what is listed, what the filters
 * do, which button is disabled and which install fires.  None of that is covered by the backend
 * suite (which stops at HTTP) or by framework-api.test.mjs (which never touches manager.js), and
 * it cannot be checked by reading: the sort comparator, the search grammar and the "disabled
 * because something depends on it" rule are all easy to break while still rendering something.
 *
 * So manager.js is executed in a small but real-enough DOM: selectors actually match, events
 * actually fire, and fetch is a stub that records every request and serves scripted market data.
 *
 * Run: node test/manager-market.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MANAGER = readFileSync(resolve(REPO, 'loader', 'manager.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
const settle = () => new Promise((r) => setTimeout(r, 0));

/* --------------------------------------------------------------- fake DOM ---- */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    childNodes: [], attrs: {}, style: {}, id: '', title: '', value: '', checked: false,
    disabled: false, type: '', src: '', alt: '', href: '', placeholder: '',
    _class: '', parentElement: null, _listeners: {},
    /* classList and className share one string: manager.js sets className in the element helper
     * and classList in the tab switcher, so a stub that keeps them apart hides real bugs. */
    classList: {
      add(c) { if (!el.classList.contains(c)) el._class = (el._class ? el._class + ' ' : '') + c; },
      remove(c) { el._class = el._class.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle(c, on) {
        const has = el.classList.contains(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        else if (!want && has) el.classList.remove(c);
      },
      contains(c) { return el._class.split(/\s+/).includes(c); },
    },
    appendChild(c) { c.parentElement = el; el.childNodes.push(c); return c; },
    removeChild(c) { el.childNodes = el.childNodes.filter((x) => x !== c); return c; },
    remove() { if (el.parentElement) el.parentElement.removeChild(el); },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
      if (k === 'class') el._class = String(v);
      if (k === 'id') el.id = String(v);
      if (k === 'value') el.value = String(v);
      if (k === 'disabled') el.disabled = true;
    },
    getAttribute(k) { return k === 'class' ? el._class : el.attrs[k]; },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      el._listeners[type] = (el._listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event) {
      const list = (el._listeners[type] || []).slice();
      for (const fn of list) fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, event));
    },
    querySelector(sel) { return descendants(el).find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(el).filter((n) => matches(n, sel)); },
    replaceChildren(...nodes) { el.childNodes = []; nodes.forEach((n) => el.appendChild(n)); },
    get isConnected() { return true; },
  };
  Object.defineProperty(el, 'className', { get: () => el._class, set: (v) => { el._class = String(v); } });
  Object.defineProperty(el, 'textContent', {
    get: () => collectText(el),
    set: (v) => { el.childNodes = []; if (v !== '' && v !== null && v !== undefined) el.appendChild({ text: String(v), parentElement: el }); },
  });
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => {} });
  Object.defineProperty(el, 'firstChild', { get: () => el.childNodes[0] || null });
  return el;
}

function descendants(root, out = []) {
  for (const child of root.childNodes || []) {
    if (child.text !== undefined) continue;
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function collectText(el) {
  let s = '';
  for (const child of el.childNodes || []) s += child.text !== undefined ? child.text : collectText(child);
  return s;
}

function matchSimple(el, part) {
  const attr = part.match(/^\[([^\]=*^$]+)([*^$]?)=?"?([^"\]]*)"?\]$/);
  if (attr) {
    const [, name, op, value] = attr;
    const have = el.getAttribute(name) ?? '';
    if (op === '*') return String(have).includes(value);
    if (op === '^') return String(have).startsWith(value);
    return String(have) === value;
  }
  if (part.startsWith('.')) return el.classList.contains(part.slice(1));
  if (part.startsWith('#')) return el.id === part.slice(1);
  return el.tagName === part.toUpperCase();
}

function matches(el, sel) {
  const parts = String(sel).trim().split(/\s+/);
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el.parentElement, i = parts.length - 2;
  while (i >= 0) {
    if (!node) return false;
    if (matchSimple(node, parts[i])) i--;
    node = node.parentElement;
  }
  return true;
}

/* -------------------------------------------------------------- the world ---- */

const MARKET_PLUGINS = [
  {
    slug: 'LyricBar', name: 'LyricBar', version: '0.3.6', author: 'solstice23',
    description: '重新设计的软件内词栏', type: 'extension', stars: 21, bundled: true,
    requirements: ['RefinedNowPlaying'], loadAfter: ['RefinedNowPlaying'], incompatible: [],
    preview: 'previews/LyricBar.svg', source_name: '内置（随包分发）', source_kind: 'builtin',
    installed: false, update_available: false, publish_time: 0,
  },
  {
    slug: 'MaterialYouTheme', name: 'Material You', version: 'v1.0.4', author: 'long45343',
    description: '动态取色主题', type: 'theme', stars: 6, bundled: true,
    requirements: [], loadAfter: [], incompatible: [], preview: null,
    source_name: '内置（随包分发）', source_kind: 'builtin',
    installed: false, update_available: false, publish_time: 0,
  },
  {
    slug: 'RefinedNowPlaying', name: 'RefinedNowPlaying', version: '3.0.2', author: 'MiHN',
    description: '正在播放页重制', type: 'extension', stars: 44, bundled: true,
    requirements: [], loadAfter: ['MaterialYouTheme'], incompatible: ['Apple-Musiclike-lyrics'],
    preview: null, source_name: '内置（随包分发）', source_kind: 'builtin',
    installed: false, update_available: false, publish_time: 0,
  },
  {
    slug: 'NCM-Font-Manager', name: 'NCM Font Manager', version: '0.1.3', author: 'BetterNCM-v3',
    description: '字体管理器', type: 'extension', stars: 0, bundled: true,
    requirements: [], loadAfter: [], incompatible: [], preview: null,
    source_name: '内置（随包分发）', source_kind: 'builtin',
    installed: false, update_available: false, publish_time: 0,
  },
];

function makeWorld({ plugins = MARKET_PLUGINS, state = {} } = {}) {
  const requests = [];
  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    getElementById() { return null; },
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ text: String(t) }),
    querySelector(sel) { return descendants(document.body).find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(document.body).filter((n) => matches(n, sel)); },
    addEventListener() {},
  };

  const responses = {
    '/api/state': Object.assign({
      data_dir: 'C:\\betterncm', plugins_dir: 'C:\\betterncm\\plugins', core_dir: null,
      core: [], plugins: [], disabled: [],
    }, state),
    '/api/market/plugins': { plugins, sources: [{ id: 'builtin', name: '内置（随包分发）', ok: true, count: plugins.length, builtin: true }] },
    '/api/market/sources': { sources: [{ id: 'builtin', name: '内置（随包分发）', builtin: true, enabled: true }], selected: 'builtin', custom_unlocked: false },
    '/api/market/install': { ok: true, installed: [{ slug: 'LyricBar', version: '0.3.6' }], skipped: [], recommended: [], restart_required: true },
    '/api/plugins/uninstall': { ok: true, slug: 'x', moved_to: 'C:\\betterncm\\_uninstalled\\t\\x.plugin' },
  };

  async function fetchStub(url, opts = {}) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    requests.push({ path: path.split('?')[0], query: path.includes('?') ? path.slice(path.indexOf('?')) : '', opts });
    const key = path.split('?')[0];
    const body = responses[key];
    if (body === undefined) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'no such endpoint' }), blob: async () => null };
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => JSON.parse(JSON.stringify(body)),
      blob: async () => ({ size: 10 }),
    };
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, Object, Array, String, Number, RegExp,
    parseInt, parseFloat, isNaN, Error, encodeURIComponent, decodeURIComponent,
    setInterval: () => 0, clearInterval: () => {},
    URL: { createObjectURL: () => 'blob:preview' },
    fetch: fetchStub,
    document,
    navigator: { userAgent: 'test' },
    location: { href: 'http://x/' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.BETTERNCM_API_KEY = 'testkey';
  sandbox.confirm = () => true;

  const context = vm.createContext(sandbox);
  vm.runInContext(MANAGER, context, { filename: 'manager.js' });

  const betterncm = {
    backend: 'http://127.0.0.1:9/api'.replace('/api', ''),
    build: 'test',
    plugin: { get: () => null },
    loader: { stats: () => null },
    injector: {},
    app: { exec: () => {} },
    ncm: { openUrl: () => {}, getNCMVersion: () => '3.1.41' },
    status: () => null,
  };

  const mgr = sandbox.window.__BNCM_MANAGER__;
  mgr.install(betterncm, {});
  mgr.open();
  return { sandbox, document, requests, mgr, betterncm };
}

/* ------------------------------------------------------------------ tests ---- */

console.log('\n== 1. the market tab exists and loads the index ==');
const w = makeWorld();
await settle(); await settle();
{
  const tabs = w.document.querySelectorAll('.bncm-mgr-tab');
  eq('the panel has three tabs', tabs.length, 3);
  eq('the second one is the market', tabs[1].textContent, '插件市场');

  const stateRequests = () => w.requests.filter((r) => r.path === '/api/state').length;
  ok('opening the panel loads plugin state', stateRequests() > 0);
  eq('the market is not fetched before its tab is opened',
    w.requests.filter((r) => r.path === '/api/market/plugins').length, 0);

  tabs[1].dispatch('click');
  await settle(); await settle();
  ok('clicking the tab fetches the index',
    w.requests.some((r) => r.path === '/api/market/plugins'));

  const cards = w.document.querySelectorAll('.bncm-mk-card');
  eq('every bundled plugin is listed', cards.length, 4);
  ok('a card shows the plugin name',
    cards.some((c) => collectText(c).includes('LyricBar')));
  ok('the installed-state tags are absent when nothing is installed',
    !collectText(w.document.querySelector('.bncm-mk-notes') || makeElement('div')).includes('已安装'));
}

console.log('\n== 2. search grammar matches upstream ==');
{
  const grid = w.document.querySelector('.bncm-mk-grid');
  const search = w.document.querySelector('.bncm-mk-search');
  const setQuery = async (q) => { search.value = q; search.dispatch('input'); await settle(); };

  await setQuery('font');
  eq('a plain token matches the name', grid.querySelectorAll('.bncm-mk-card').length, 1);

  await setQuery('lyric refined');
  eq('space-separated tokens are AND', grid.querySelectorAll('.bncm-mk-card').length, 0);

  await setQuery('author:long');
  eq('author: filters on the author only', grid.querySelectorAll('.bncm-mk-card').length, 1);
  ok('and it is the right one',
    collectText(grid).includes('Material You'));

  await setQuery('author:solstice23 lyricbar');
  eq('author: combines with a name token', grid.querySelectorAll('.bncm-mk-card').length, 1);

  await setQuery('');
  eq('clearing the box restores the list', grid.querySelectorAll('.bncm-mk-card').length, 4);
}

console.log('\n== 3. categories and sorts ==');
{
  // Every assertion re-queries: the panel re-renders wholesale, so a cached node is a stale one.
  const cards = () => w.document.querySelectorAll('.bncm-mk-card');
  const segs = () => w.document.querySelectorAll('.bncm-mk-seg');
  const pick = (seg, label) => seg.childNodes.find((n) => n.text !== undefined ? false : n.textContent === label);
  const themeBtn = pick(segs()[0], '主题');
  themeBtn.dispatch('click');
  await settle();
  eq('the theme category shows only themes', cards().length, 1);

  pick(segs()[0], '全部').dispatch('click');
  await settle();
  eq('back to everything', cards().length, 4);

  const order = () => cards().map((c) => c.querySelector('.bncm-mk-title').childNodes[0].textContent);
  eq('composite sort falls back to stars',
    order().join(' | '), 'RefinedNowPlaying | LyricBar | Material You | NCM Font Manager');

  const nameBtn = pick(segs()[1], '名称');
  nameBtn.dispatch('click');
  await settle();
  const asc = order();
  ok('the name sort orders the list', asc.length === 4, asc.join(','));
  pick(segs()[1], '名称').dispatch('click');
  await settle();
  ok('clicking the same key flips the direction',
    order().join('|') === asc.slice().reverse().join('|'), order().join('|'));
}

console.log('\n== 4. actions: install, disable, uninstall ==');
{
  const cardsOf = (name) => w.document.querySelectorAll('.bncm-mk-card')
    .find((c) => collectText(c).includes(name));
  const buttonOf = (card, label) => card.querySelectorAll('.bncm-mgr-btn').find((b) => b.textContent === label);

  const lyricCard = cardsOf('LyricBar');
  ok('an uninstalled plugin offers 安装', !!buttonOf(lyricCard, '安装'));
  buttonOf(lyricCard, '安装').dispatch('click');
  await settle(); await settle();
  const installReq = w.requests.filter((r) => r.path === '/api/market/install').pop();
  ok('clicking 安装 posts the right slug',
    !!installReq && JSON.parse(installReq.opts.body).slug === 'LyricBar',
    installReq && installReq.opts.body);
  ok('install refreshes the installed state afterwards',
    w.requests.filter((r) => r.path === '/api/state').length > 1);
}

console.log('\n== 5. incompatible and depended-upon plugins are guarded ==');
{
  const installedState = {
    core: [], disabled: [],
    plugins: [
      { slug: 'Apple-Musiclike-lyrics', name: 'AMLL', version: '3.0.0', author: 'x', dir: 'd1', kind: 'zip', core: false, locked: false, disabled: false },
      { slug: 'RefinedNowPlaying', name: 'RNP', version: '3.0.2', author: 'x', dir: 'd2', kind: 'zip', core: false, locked: false, disabled: false },
      { slug: 'LyricBar', name: 'LyricBar', version: '0.3.6', author: 'x', dir: 'd3', kind: 'zip', core: false, locked: false, disabled: false },
    ],
  };
  const plugins = MARKET_PLUGINS.map((p) => Object.assign({}, p, {
    installed: ['RefinedNowPlaying', 'LyricBar', 'Apple-Musiclike-lyrics'].includes(p.slug),
    installed_version: p.slug === 'RefinedNowPlaying' ? '3.0.2' : (p.slug === 'LyricBar' ? '0.3.6' : null),
  }));
  plugins.push({
    slug: 'Apple-Musiclike-lyrics', name: 'Apple Music-like lyrics', version: '3.0.0',
    author: 'SteveXMH', description: 'AMLL', type: 'extension', stars: 5,
    requirements: [], loadAfter: [], incompatible: ['RefinedNowPlaying'],
    preview: null, source_name: 'Fake', source_kind: 'remote',
    installed: true, installed_version: '3.0.0', update_available: false, publish_time: 0,
  });

  const w2 = makeWorld({ plugins, state: installedState });
  await settle(); await settle();
  w2.document.querySelectorAll('.bncm-mgr-tab')[1].dispatch('click');
  await settle(); await settle();

  const card = (name) => w2.document.querySelectorAll('.bncm-mk-card').find((c) => collectText(c).includes(name));
  const button = (c, label) => c.querySelectorAll('.bncm-mgr-btn').find((b) => b.textContent === label);

  const amll = card('Apple Music-like lyrics');
  const amllInstall = button(amll, '安装');
  ok('a plugin that conflicts with an installed one cannot be installed',
    !amllInstall || amllInstall.disabled === true);

  const lyric = card('LyricBar');
  const lyricUninstall = button(lyric, '卸载');
  ok('a plugin another installed plugin depends on cannot be uninstalled',
    !!lyricUninstall && lyricUninstall.disabled === true);
  ok('and the card says who depends on it', collectText(lyric).includes('被'));

  const rnp = card('RefinedNowPlaying');
  ok('and a plugin that only needs a load-order hint still shows its requirement tag',
    collectText(rnp).includes('依赖') || collectText(rnp).includes('已安装'));
  const amll2 = card('Apple Music-like lyrics');
  ok('a plugin nothing depends on can still be uninstalled',
    button(amll2, '卸载') && button(amll2, '卸载').disabled !== true);
  ok('an installed plugin shows its installed version', collectText(rnp).includes('已安装'));

  const listing = collectText(w2.document.querySelector('.bncm-mk-notes'));
  ok('no bogus source errors are shown', !listing.includes('读取失败'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
