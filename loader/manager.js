/* manager.js -- the BetterNCM plugin manager UI for NCM 3.1.41.
 *
 * Served by tools/ncm_host.mjs and installed by loader/framework.js.  This is a REWRITE, not a
 * port: upstream's manager renders a React app into a <section> it splices into the client's
 * page layout and opens from a clone of the settings gear.  That approach depends on the
 * client's CSS-module class names, which drift with every frontend pack -- and in 3.1.41 both
 * anchors it used (`.cmd-icon-setting`, `section.g-mn`) are already gone.
 *
 * So the entry point and the panel are both self-healing:
 *   * the entry button is inserted next to the real settings gear when one can be identified
 *     through the selector registry, and otherwise degrades to a small floating launcher, so
 *     the manager is reachable no matter what the frontend pack does;
 *   * the panel is a fixed overlay with its own namespaced CSS, so it cannot be broken by the
 *     client's styles and cannot break the client's layout.
 *
 * The plugin model has two classes, and the difference is load-bearing:
 *   * CORE plugins ship with the loader.  They are shown with a lock badge and have NO
 *     enable/disable control and NO uninstall control.  The host enforces the same rule with a
 *     403, so this is a presentation of a real invariant, not a UI trick.
 *   * USER plugins are fully managed: config, enable/disable, uninstall (which moves the file
 *     aside rather than deleting it).
 */
(function () {
  'use strict';

  if (window.__BNCM_MANAGER__) return;
  var BUILD = 'bncm-v3-manager/0.3.0';

  var api = null;          // betterncm
  var helpers = null;      // { loadedPlugins, reload }
  var panel = null;
  var entry = null;
  var state = null;        // last /api/state payload
  var selected = null;     // slug being configured
  var tab = 'plugins';     // plugins | market | diagnostics
  var notes = [];          // in-panel messages

  /* Plugin market state.  Upstream keeps all of this inside a React component; here it is one
   * plain object because the panel re-renders wholesale.  The FIELDS mirror upstream's contract
   * (category / search / sort_by / sort_order + the reload notice) so the two behave alike. */
  var market = {
    data: null,            // /api/market/plugins payload
    sources: null,         // /api/market/sources payload
    error: null,
    loading: false,
    q: '',
    category: 'all',
    sort: 'composite',
    order: 'desc',
    busy: null,            // slug currently installing/removing
    note: null,            // {kind, text}
    showSources: false,
    showLibs: false,
    devOptions: false,
    reload: false,         // "changes need a reload" notice
    previews: {},          // slug -> object URL
  };

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') { for (var s in v) el.style[s] = v[s]; }
        else el.setAttribute(k, v);
      }
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function log(msg) { try { console.log('[BetterNCM/manager] ' + msg); } catch (e) { /* ignore */ } }

  /* ------------------------------------------------------------- styling ---- */

  var CSS = [
    '.bncm-mgr-fab{position:fixed;right:14px;bottom:52px;z-index:2147483646;width:34px;height:34px;',
    'border-radius:50%;background:rgba(20,20,24,.9);color:#fff;border:1px solid rgba(255,255,255,.18);',
    'display:flex;align-items:center;justify-content:center;cursor:pointer;font:600 13px/1 system-ui,sans-serif;',
    'box-shadow:0 3px 12px rgba(0,0,0,.4)}',
    '.bncm-mgr-fab:hover{background:#ff5c5c}',
    '.bncm-mgr{position:fixed;inset:0 0 0 auto;width:min(760px,86vw);z-index:2147483647;',
    'background:#17171b;color:#e9e9ee;display:flex;flex-direction:column;',
    'font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft Yahei",sans-serif;',
    'box-shadow:-12px 0 32px rgba(0,0,0,.45);transform:translateX(102%);transition:transform .18s ease-out}',
    '.bncm-mgr.open{transform:translateX(0)}',
    '.bncm-mgr *{box-sizing:border-box}',
    '.bncm-mgr-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #ffffff1f}',
    '.bncm-mgr-title{font-size:15px;font-weight:600}',
    '.bncm-mgr-build{color:#8b8b96;font-size:11px}',
    '.bncm-mgr-tabs{margin-left:auto;display:flex;gap:6px}',
    '.bncm-mgr-tab{padding:4px 10px;border-radius:6px;cursor:pointer;color:#b9b9c4;border:1px solid transparent}',
    '.bncm-mgr-tab.active{background:#ffffff14;color:#fff;border-color:#ffffff26}',
    '.bncm-mgr-close{cursor:pointer;padding:4px 8px;border-radius:6px;color:#b9b9c4}',
    '.bncm-mgr-close:hover{background:#ffffff14;color:#fff}',
    '.bncm-mgr-body{display:flex;flex:1;min-height:0}',
    '.bncm-mgr-list{width:266px;border-right:1px solid #ffffff1f;overflow:auto;padding:8px 0}',
    '.bncm-mgr-group{padding:8px 14px 4px;color:#8b8b96;font-size:11px;letter-spacing:.04em;text-transform:uppercase}',
    '.bncm-mgr-item{display:flex;align-items:center;gap:8px;padding:8px 14px;cursor:pointer;position:relative}',
    '.bncm-mgr-item:hover{background:#ffffff0f}',
    '.bncm-mgr-item.active{background:#ffffff1a}',
    '.bncm-mgr-item-body{min-width:0;flex:1}',
    '.bncm-mgr-item-name{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bncm-mgr-item-sub{display:block;color:#8b8b96;font-size:11px}',
    '.bncm-mgr-lock{font-size:10px;padding:1px 6px;border-radius:10px;background:#3a2f16;color:#e8c274;white-space:nowrap}',
    '.bncm-mgr-state{font-size:10px;padding:1px 6px;border-radius:10px;white-space:nowrap}',
    '.bncm-mgr-state.loaded{background:#16321f;color:#7fd6a0}',
    '.bncm-mgr-state.error{background:#3a1a1a;color:#ff8f8f}',
    '.bncm-mgr-state.skipped{background:#2a2a33;color:#a5a5b3}',
    '.bncm-mgr-main{flex:1;min-width:0;overflow:auto;padding:16px}',
    '.bncm-mgr-h1{font-size:14px;font-weight:600;margin:0 0 2px}',
    '.bncm-mgr-meta{color:#8b8b96;font-size:11px;margin-bottom:12px}',
    '.bncm-mgr-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px}',
    '.bncm-mgr-btn{padding:5px 12px;border-radius:7px;border:1px solid #ffffff2b;background:#ffffff12;',
    'color:#e9e9ee;cursor:pointer;font-size:12px}',
    '.bncm-mgr-btn:hover{background:#ffffff1f}',
    '.bncm-mgr-btn.danger{border-color:#ff6b6b55;color:#ff9d9d}',
    '.bncm-mgr-btn.danger:hover{background:#ff6b6b1f}',
    '.bncm-mgr-note{padding:8px 10px;border-radius:8px;background:#ffffff0f;color:#b9b9c4;margin:6px 0;font-size:12px}',
    '.bncm-mgr-note.warn{background:#3a2f1640;color:#e8c274}',
    '.bncm-mgr-note.err{background:#3a1a1a66;color:#ff9d9d}',
    '.bncm-mgr-kv{display:grid;grid-template-columns:210px 1fr;gap:2px 12px;font-size:12px}',
    '.bncm-mgr-kv dt{color:#8b8b96}',
    '.bncm-mgr-kv dd{margin:0;word-break:break-all}',
    '.bncm-mgr-empty{color:#8b8b96;padding:20px 0}',
    '.bncm-mgr svg{display:block}',
    /* ---- plugin market ---------------------------------------------------- */
    '.bncm-mk-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}',
    '.bncm-mk-search{flex:1;min-width:150px;padding:6px 10px;border-radius:8px;border:1px solid #ffffff26;',
    'background:#ffffff0f;color:#e9e9ee;font-size:12px;outline:none}',
    '.bncm-mk-search::placeholder{color:#7c7c88}',
    '.bncm-mk-seg{display:flex;border:1px solid #ffffff26;border-radius:8px;overflow:hidden}',
    '.bncm-mk-seg>span{padding:5px 10px;font-size:12px;color:#b9b9c4;cursor:pointer;white-space:nowrap}',
    '.bncm-mk-seg>span.active{background:#ffffff1f;color:#fff}',
    '.bncm-mk-select{padding:5px 8px;border-radius:8px;border:1px solid #ffffff26;background:#1e1e24;',
    'color:#e9e9ee;font-size:12px}',
    '.bncm-mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}',
    '.bncm-mk-card{display:flex;gap:10px;padding:10px;border:1px solid #ffffff1f;border-radius:12px;',
    'background:#ffffff08}',
    '.bncm-mk-card.busy{opacity:.55;pointer-events:none}',
    '.bncm-mk-card.installed{border-color:#7fd6a033}',
    '.bncm-mk-thumb{width:104px;height:60px;flex:0 0 104px;border-radius:8px;overflow:hidden;background:#0e0e12;',
    'display:flex;align-items:center;justify-content:center;color:#5c5c68;font-size:20px}',
    '.bncm-mk-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.bncm-mk-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}',
    '.bncm-mk-title{display:flex;align-items:baseline;gap:6px;font-weight:600;font-size:13px;min-width:0}',
    '.bncm-mk-title>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bncm-mk-ver{color:#8b8b96;font-size:11px;font-weight:400;flex:0 0 auto}',
    '.bncm-mk-sub{color:#8b8b96;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bncm-mk-desc{color:#c8c8d2;font-size:11.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;',
    '-webkit-box-orient:vertical;overflow:hidden}',
    '.bncm-mk-tags{display:flex;gap:4px;flex-wrap:wrap}',
    '.bncm-mk-tag{font-size:10px;padding:1px 6px;border-radius:10px;background:#2a2a33;color:#a5a5b3;white-space:nowrap}',
    '.bncm-mk-tag.ok{background:#16321f;color:#7fd6a0}',
    '.bncm-mk-tag.warn{background:#3a2f16;color:#e8c274}',
    '.bncm-mk-tag.err{background:#3a1a1a;color:#ff9f9f}',
    '.bncm-mk-tag.info{background:#152a3a;color:#7fc4e8}',
    '.bncm-mk-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}',
    '.bncm-mk-actions .bncm-mgr-btn{padding:3px 9px;font-size:11px}',
    '.bncm-mk-sources{border:1px solid #ffffff1f;border-radius:10px;padding:10px;margin:0 0 12px;',
    'background:#ffffff08;font-size:12px}',
    '.bncm-mk-src-row{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid #ffffff12}',
    '.bncm-mk-src-row:last-child{border-bottom:0}',
    '.bncm-mk-src-name{flex:1;min-width:0}',
    '.bncm-mk-src-base{color:#7c7c88;font-size:10.5px;word-break:break-all}',
    '.bncm-mk-input{flex:1;min-width:140px;padding:5px 8px;border-radius:8px;border:1px solid #ffffff26;',
    'background:#ffffff0f;color:#e9e9ee;font-size:11.5px}',
    '.bncm-mk-check{display:flex;align-items:center;gap:6px;color:#b9b9c4;cursor:pointer}',
  ].join('');

  function ensureStyles() {
    if (document.getElementById('bncm-manager-style')) return;
    var s = document.createElement('style');
    s.id = 'bncm-manager-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------------------------------------------------------------- data ---- */

  function host(path, opts) {
    if (!api || !api.backend) return Promise.reject(new Error('no backend'));
    var headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    headers['X-BNCM-Key'] = window.BETTERNCM_API_KEY || '';
    return fetch(api.backend + path, Object.assign({}, opts || {}, { headers: headers }))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
      });
  }

  function refresh() {
    return host('/api/state').then(function (s) {
      state = s;
      notes = [];
      renderList();
      renderMain();
    }, function (e) {
      notes = [{ kind: 'err', text: '无法读取插件状态：' + e.message }];
      renderMain();
    });
  }

  function ctxFor(slug) {
    try { return api.plugin.get(slug); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- view ---- */

  /** Per-plugin load timing from the framework's own telemetry (betterncm.loader.stats()).
   *  The host snapshot (/api/state) knows what is installed; only the page knows how long it took
   *  to download, evaluate and run each plugin -- and that is the number that answers "which one
   *  made my client stutter". */
  function pluginPerf(slug) {
    try {
      var st = api.loader && api.loader.stats();
      if (!st || !st.per_plugin) return null;
      for (var i = 0; i < st.per_plugin.length; i++) {
        if (st.per_plugin[i].slug === slug) return st.per_plugin[i];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function renderList() {
    if (!panel) return;
    var list = panel.querySelector('.bncm-mgr-list');
    // The market is a full-width view: the plugin list has nothing to say about it.
    list.style.display = tab === 'market' ? 'none' : '';
    list.textContent = '';
    if (!state) { list.appendChild(h('div', { class: 'bncm-mgr-empty', text: '加载中…' })); return; }

    function item(p) {
      var el = h('div', {
        class: 'bncm-mgr-item' + (selected === p.slug ? ' active' : ''),
        onclick: function () { selected = p.slug; tab = 'plugins'; renderList(); renderMain(); },
      });
      el.appendChild(h('div', { class: 'bncm-mgr-item-body' }, [
        h('span', { class: 'bncm-mgr-item-name', text: p.name || p.slug || '(未命名)' }),
        h('span', { class: 'bncm-mgr-item-sub', text: (p.version || '')
          + (p.author ? ' · ' + p.author : '')
          + (p.disabled ? ' · 已禁用' : '') }),
      ]));
      var pf = pluginPerf(p.slug);
      if (pf && !p.disabled) {
        el.appendChild(h('span', {
          class: 'bncm-mgr-state' + (pf.slow || pf.timed_out ? ' error' : ''),
          title: '下载等待 ' + Math.round(pf.fetch_ms) + 'ms · 执行 ' + Math.round(pf.eval_ms)
              + 'ms · 生命周期 ' + Math.round(pf.hook_ms) + 'ms',
          text: Math.round(pf.load_ms) + 'ms',
        }));
      }
      if (p.core) el.appendChild(h('span', { class: 'bncm-mgr-lock', text: '锁定' }));
      if (p.error) el.appendChild(h('span', { class: 'bncm-mgr-state error', text: '错误' }));
      return el;
    }

    if (state.core && state.core.length) {
      list.appendChild(h('div', { class: 'bncm-mgr-group', text: '内置插件（不可删除 / 不可禁用）' }));
      state.core.forEach(function (p) { list.appendChild(item(p)); });
    }
    list.appendChild(h('div', { class: 'bncm-mgr-group', text: '用户插件' }));
    if (!state.plugins || !state.plugins.length) {
      list.appendChild(h('div', { class: 'bncm-mgr-item', text: '（没有已安装的用户插件）' }));
    } else {
      state.plugins.forEach(function (p) { list.appendChild(item(p)); });
    }
  }

  function renderMain() {
    if (!panel) return;
    var main = panel.querySelector('.bncm-mgr-main');
    main.textContent = '';
    if (tab === 'diagnostics') return renderDiagnostics(main);
    if (tab === 'market') return renderMarket(main);

    if (!selected) {
      main.appendChild(h('div', { class: 'bncm-mgr-empty', text: '从左侧选择一个插件查看设置。' }));
    } else {
      var p = findEntry(selected);
      if (!p) { main.appendChild(h('div', { class: 'bncm-mgr-empty', text: '插件已不存在，请刷新。' })); return; }

      main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: p.name || p.slug }));
      main.appendChild(h('div', { class: 'bncm-mgr-meta', text: [
        'slug: ' + p.slug,
        'version: ' + (p.version || '?'),
        'author: ' + (p.author || '?'),
        'dir: ' + (p.dir || '?'),
      ].join('  ·  ') }));

      var pf = pluginPerf(p.slug);
      if (pf) {
        main.appendChild(h('div', { class: 'bncm-mgr-meta', text:
          '加载耗时：共 ' + Math.round(pf.load_ms) + 'ms  ·  下载等待 ' + Math.round(pf.fetch_ms) +
          'ms  ·  脚本执行 ' + Math.round(pf.eval_ms) + 'ms  ·  生命周期钩子 ' + Math.round(pf.hook_ms) + 'ms' +
          (pf.scripts > 1 ? '  ·  ' + pf.scripts + ' 个脚本' : '') +
          (pf.timed_out ? '  ·  已超时' : '') }));
      }
      if (pf && (pf.slow || pf.timed_out)) {
        main.appendChild(h('div', { class: 'bncm-mgr-note warn',
          text: '这个插件超出了加载预算：它拖慢的是自己的加载和排在它后面的插件。可以试试联系作者，或先禁用它。' }));
      }

      if (p.core) {
        main.appendChild(h('div', { class: 'bncm-mgr-note warn',
          text: '内置插件随加载器一起分发，无法禁用或卸载。如果你需要它停止工作，请改用“用户插件”机制或卸载整个加载器。' }));
      }
      if (p.error) {
        main.appendChild(h('div', { class: 'bncm-mgr-note err', text: '加载错误：' + p.error }));
      }

      var actions = h('div', { class: 'bncm-mgr-actions' });
      if (!p.core) {
        actions.appendChild(h('button', {
          class: 'bncm-mgr-btn',
          text: p.disabled ? '启用插件' : '禁用插件',
          onclick: function () { act(p, p.disabled ? 'enable' : 'disable'); },
        }));
        actions.appendChild(h('button', {
          class: 'bncm-mgr-btn danger',
          text: '卸载',
          onclick: function () {
            if (!window.confirm('卸载 ' + (p.name || p.slug) + '？插件文件会被移动到 <数据目录>\\_uninstalled\\ 而不是删除。')) return;
            act(p, 'uninstall');
          },
        }));
      }
      actions.appendChild(h('button', { class: 'bncm-mgr-btn', text: '重载全部插件', onclick: doReload }));
      main.appendChild(actions);

      notes.forEach(function (n) { main.appendChild(h('div', { class: 'bncm-mgr-note ' + (n.kind || ''), text: n.text })); });

      // The plugin's own settings view.  _getConfigElement() dispatches the `config` event that
      // fires plugin.onConfig, so this is what makes any plugin's settings actually exist.
      var box = h('div', { class: 'bncm-mgr-config' });
      var ctx = ctxFor(p.slug);
      var view = null;
      try { if (ctx && typeof ctx._getConfigElement === 'function') view = ctx._getConfigElement(); }
      catch (e) { notes.push({ kind: 'err', text: '构建设置视图失败：' + (e && e.message) }); }
      if (view) box.appendChild(view);
      else box.appendChild(h('div', { class: 'bncm-mgr-empty', text: '该插件没有提供设置项。' }));
      main.appendChild(box);
    }
  }

  function findEntry(slug) {
    if (!state) return null;
    var all = [].concat(state.core || [], state.plugins || []);
    for (var i = 0; i < all.length; i++) if (all[i].slug === slug) return all[i];
    return null;
  }

  function act(p, action) {
    host('/api/plugins/' + action, { method: 'POST', body: JSON.stringify({ slug: p.slug }) })
      .then(function (r) {
        notes = [{ text: action === 'uninstall'
          ? '已卸载，文件移动到 ' + r.moved_to
          : (action === 'disable' ? '已禁用。' : '已启用。') }];
        if (action === 'uninstall') selected = null;
        return doReload();
      }, function (e) {
        notes = [{ kind: 'err', text: '操作失败：' + e.message }];
        renderMain();
      });
  }

  function doReload() {
    var reload = helpers && helpers.reload;
    return Promise.resolve(reload ? reload() : null).then(function () {
      log('plugins reloaded');
      return refresh();
    });
  }

  /* --------------------------------------------------------- plugin market ---- */
  /* Upstream ships its market as a PLUGIN: a React app that fetches `plugins.json` from one of a
   * few mirrors and writes the chosen archive through `betterncm.fs`.  Here the market is part of
   * the host, which is what makes three things possible that upstream cannot do:
   *
   *   * the bundled source is a directory, so the four plugins this build ships are installable
   *     with no network and no mirror;
   *   * an install is verified (zip parses, slug matches, sha256 matches) BEFORE it lands, so a
   *     bad mirror cannot destroy the working copy of a plugin;
   *   * a failure is shown.  Upstream's install has no try/catch, so a 404 leaves the card
   *     spinning forever.
   *
   * Preserved on purpose: the index contract, the merge order, the dependency semantics, the
   * search grammar (`author:x` plus space-separated AND), the five sort keys, the composite bonus
   * curve, and the rule that an install never reloads the page by itself. */

  var LIB_TYPES = ['lib', 'library', 'dependency', 'framework'];
  var NEW_WINDOW_S = 5 * 24 * 60 * 60;

  function marketPlugins() { return (market.data && market.data.plugins) || []; }
  function findMarket(slug) {
    var all = marketPlugins();
    for (var i = 0; i < all.length; i++) if (all[i].slug === slug) return all[i];
    return null;
  }
  function isLib(p) { return LIB_TYPES.indexOf(String(p.type || 'extension')) >= 0; }
  function isNew(p) {
    return !!p.publish_time && (Date.now() / 1000 - Number(p.publish_time)) < NEW_WINDOW_S;
  }

  /** How many plugins the user actually has, per source: the number that says "this mirror is
   *  doing something".  Installed state comes from the host, so the two lists never disagree. */
  function marketSourceReport(id) {
    if (!market.data || !market.data.sources) return null;
    for (var i = 0; i < market.data.sources.length; i++) {
      if (market.data.sources[i].id === id) return market.data.sources[i];
    }
    return null;
  }

  function marketMaxDownloads() {
    var max = 0;
    marketPlugins().forEach(function (p) {
      var d = Number(p.downloads || 0);
      if (d > max) max = d;
    });
    return max;
  }

  /** Upstream's "bonus downloads" curve, kept verbatim: a fresh release is weighted like the most
   *  downloaded plugin on the site, decaying to 85% at 90 days and then 1% per hour.  It is what
   *  makes the composite sort surface new work instead of a frozen popularity ranking. */
  function bonusDownloads(p, max) {
    if (!p.publish_time || !max) return 0;
    var turningPoint = 24 * 30 * 3;      // 90 days, in hours
    var turningValue = 0.85;
    var hours = Math.max(0, (Date.now() - Number(p.publish_time) * 1000) / 1000 / 60 / 60);
    var factor = hours < turningPoint
      ? Math.pow((turningPoint - hours) / turningPoint, 6) * (1 - turningValue) + turningValue
      : turningValue * Math.pow(0.99, hours - turningPoint);
    return parseInt(factor * max, 10);
  }

  function marketVisible() {
    var all = marketPlugins();
    var max = marketMaxDownloads();
    var stats = max > 0;
    var q = market.q.trim().toLowerCase();
    var tokens = q ? q.split(/\s+/) : [];

    var list = all.filter(function (p) {
      if (p.deprecated || p.hide) return false;
      var type = String(p.type || 'extension');
      if (market.category === 'installed') { if (!p.installed) return false; }
      else if (market.category === 'update') { if (!p.update_available) return false; }
      else if (market.category === 'lib') { if (!isLib(p)) return false; }
      else if (market.category === 'extension' || market.category === 'theme') {
        if (type !== market.category) return false;
      } else if (!market.showLibs && isLib(p)) return false;

      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t.indexOf('author:') === 0) {
          if (String(p.author || '').toLowerCase().indexOf(t.slice(7)) < 0) return false;
        } else if ([p.name || '', p.slug || '', p.author || ''].join(' ').toLowerCase().indexOf(t) < 0) {
          return false;
        }
      }
      return true;
    });

    list.sort(function (a, b) {
      var la = isLib(a) ? 1 : 0, lb = isLib(b) ? 1 : 0;
      if (la !== lb) return la - lb;                       // libraries always last
      var va, vb;
      if (market.sort === 'downloads') {
        va = stats ? Number(a.downloads || 0) : Number(a.stars || 0);
        vb = stats ? Number(b.downloads || 0) : Number(b.stars || 0);
      } else if (market.sort === 'stars') {
        va = Number(a.stars || 0); vb = Number(b.stars || 0);
      } else if (market.sort === 'update') {
        va = Number(a.update_time || 0); vb = Number(b.update_time || 0);
      } else if (market.sort === 'name') {
        va = String(a.name || ''); vb = String(b.name || '');
      } else if (stats) {
        va = Number(a.downloads || 0) + bonusDownloads(a, max);
        vb = Number(b.downloads || 0) + bonusDownloads(b, max);
      } else {
        va = Number(a.stars || 0); vb = Number(b.stars || 0);
      }
      var cmp = va < vb ? -1 : (va > vb ? 1 : 0);
      return market.order === 'asc' ? cmp : -cmp;
    });
    return { list: list, stats: stats, total: all.length };
  }

  function beingDependedBy(slug) {
    return marketPlugins().filter(function (p) {
      return p.installed && (p.requirements || []).indexOf(slug) >= 0;
    }).map(function (p) { return p.name || p.slug; });
  }

  function marketPreviewUrl(slug) {
    if (market.previews[slug] !== undefined) return Promise.resolve(market.previews[slug]);
    market.previews[slug] = null;
    var key = window.BETTERNCM_API_KEY || '';
    return fetch(api.backend + '/api/market/preview?slug=' + encodeURIComponent(slug),
                 { headers: { 'X-BNCM-Key': key } })
      .then(function (r) { if (!r.ok) throw new Error('no preview'); return r.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        market.previews[slug] = url;
        return url;
      })
      .catch(function () { market.previews[slug] = ''; return ''; });
  }

  var marketRetry = null;

  function loadMarket(refresh) {
    market.loading = true;
    if (panel && tab === 'market') renderMain();
    return host('/api/market/plugins' + (refresh ? '?refresh=1' : ''))
      .then(function (r) {
        market.data = r;
        market.error = null;
        market.loading = false;
        return host('/api/market/sources').then(function (s) { market.sources = s; }, function () {});
      }, function (e) {
        market.loading = false;
        market.error = e.message;
      })
      .then(function () {
        if (panel && tab === 'market') renderMain();
        // A remote source that had no cache yet is being fetched in the background; one delayed
        // re-read is enough to fold its plugins in, and a single retry cannot become a poll loop.
        var pending = ((market.data && market.data.sources) || []).some(function (s) { return s.pending; });
        if (pending && !marketRetry) {
          marketRetry = setTimeout(function () {
            marketRetry = null;
            if (panel && tab === 'market' && !market.loading) loadMarket(false);
          }, 3000);
        }
      });
  }

  /** Reload the plugin list AND the market's installed/update annotations. */
  function refreshThenMarket() {
    return refresh().then(function () { return loadMarket(false); });
  }

  function marketSaveSettings(patch) {
    return host('/api/market/settings', { method: 'POST', body: JSON.stringify(patch) })
      .then(function (r) {
        market.sources = { sources: r.sources, selected: r.selected, custom_unlocked: r.custom_unlocked };
        return loadMarket(true);
      }, function (e) {
        market.note = { kind: 'err', text: '设置未保存：' + e.message };
        renderMain();
      });
  }

  function marketInstall(slug, opts) {
    market.busy = slug;
    market.note = null;
    renderMarketGrid();
    host('/api/market/install', {
      method: 'POST',
      body: JSON.stringify({ slug: slug, include_recommended: !!(opts && opts.recommended) }),
    }).then(function (r) {
      market.busy = null;
      var parts = (r.installed || []).map(function (x) { return x.slug + ' ' + x.version; });
      var text = parts.length ? '已安装：' + parts.join('、') : '没有需要写入的版本（已是同版本）';
      if ((r.skipped || []).length) {
        text += '　跳过：' + r.skipped.map(function (s) { return s.slug + '（' + s.reason + '）'; }).join('、');
      }
      if ((r.recommended || []).length) {
        text += '　建议一并安装：' + r.recommended.map(function (x) {
          return x.slug + '（' + x.reason + '）';
        }).join('、');
      }
      if (r.restart_required) market.reload = true;
      market.note = { kind: '', text: text };
      return refreshThenMarket();
    }, function (e) {
      market.busy = null;
      market.note = { kind: 'err', text: '安装失败：' + e.message };
      renderMarketGrid();
      renderMarketNotes();
    });
  }

  function marketUninstall(p) {
    var deps = beingDependedBy(p.slug);
    if (deps.length) {
      market.note = { kind: 'warn', text: p.slug + ' 被 ' + deps.join('、') + ' 依赖，先卸载它们。' };
      renderMarketNotes();
      return;
    }
    if (!window.confirm('卸载 ' + (p.name || p.slug) + '？插件文件会被移动到 <数据目录>\\_uninstalled\\ 而不是删除。')) return;
    market.busy = p.slug;
    renderMarketGrid();
    host('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ slug: p.slug }) })
      .then(function (r) {
        market.busy = null;
        market.note = { kind: '', text: '已卸载，文件移动到 ' + r.moved_to };
        market.reload = true;
        return refreshThenMarket();
      }, function (e) {
        market.busy = null;
        market.note = { kind: 'err', text: '卸载失败：' + e.message };
        renderMarketGrid();
        renderMarketNotes();
      });
  }

  function marketSegment(options, current, onPick) {
    var wrap = h('div', { class: 'bncm-mk-seg' });
    options.forEach(function (opt) {
      wrap.appendChild(h('span', {
        class: opt[0] === current ? 'active' : '',
        text: opt[1],
        title: opt[2] || '',
        onclick: function () { onPick(opt[0]); },
      }));
    });
    return wrap;
  }

  function marketCard(p, stats, max) {
    var el = h('div', { class: 'bncm-mk-card' + (p.installed ? ' installed' : '')
                             + (market.busy === p.slug ? ' busy' : '') });
    var thumb = h('div', { class: 'bncm-mk-thumb' }, [(p.name || '?').slice(0, 2)]);
    el.appendChild(thumb);
    if (p.preview && !p.unlisted) {
      var load = function () {
        if (market.previews[p.slug]) return;
        marketPreviewUrl(p.slug).then(function (url) {
          if (!url || !thumb.isConnected) return;
          thumb.textContent = '';
          thumb.appendChild(h('img', { src: url, alt: p.name || p.slug }));
        });
      };
      if (typeof IntersectionObserver === 'function') {
        var io = new IntersectionObserver(function (entries) {
          if (entries[0] && entries[0].isIntersecting) { io.disconnect(); load(); }
        });
        io.observe(thumb);
      } else load();
    }

    var body = h('div', { class: 'bncm-mk-body' });
    var title = h('div', { class: 'bncm-mk-title' }, [
      h('span', { text: p.name || p.slug }),
      h('span', { class: 'bncm-mk-ver', text: p.version ? 'v' + p.version : '' }),
    ]);
    body.appendChild(title);
    body.appendChild(h('div', { class: 'bncm-mk-sub', text: [
      p.author || '?',
      p.source_name || '',
      p.stars ? '★ ' + p.stars : '',
    ].filter(Boolean).join(' · ') }));
    if (p.description) body.appendChild(h('div', { class: 'bncm-mk-desc', text: p.description }));

    var tags = h('div', { class: 'bncm-mk-tags' });
    if (p.installed) {
      tags.appendChild(h('span', { class: 'bncm-mk-tag ok', text: '已安装 ' + (p.installed_version || '') }));
    }
    if (p.update_available) {
      tags.appendChild(h('span', { class: 'bncm-mk-tag info',
        text: '可更新 ' + (p.installed_version || '?') + ' → ' + p.version }));
    }
    if (p.bundled) tags.appendChild(h('span', { class: 'bncm-mk-tag', text: '随包分发' }));
    if (p.unlisted) tags.appendChild(h('span', { class: 'bncm-mk-tag warn', text: '来源已不在任何已启用源' }));
    if (isNew(p)) tags.appendChild(h('span', { class: 'bncm-mk-tag ok', text: 'NEW' }));
    if ((p.requirements || []).length) {
      tags.appendChild(h('span', { class: 'bncm-mk-tag',
        text: '依赖 ' + p.requirements.map(function (s) {
          var t = findMarket(s); return (t && t.name) || s;
        }).join('、') }));
    }
    if ((p.blocked_by || []).length) {
      tags.appendChild(h('span', { class: 'bncm-mk-tag err', text: '与 ' + p.blocked_by.join('、') + ' 不兼容' }));
    }
    var depBy = p.installed ? beingDependedBy(p.slug) : [];
    if (depBy.length) tags.appendChild(h('span', { class: 'bncm-mk-tag warn', text: '被 ' + depBy.join('、') + ' 依赖' }));
    if ((stats && Number(p.downloads || 0)) || market.sort === 'downloads') {
      tags.appendChild(h('span', { class: 'bncm-mk-tag',
        text: '下载 ' + Number(p.downloads || 0) + (stats ? '' : '（无统计）') }));
    }
    body.appendChild(tags);

    var actions = h('div', { class: 'bncm-mk-actions' });
    if (!p.installed) {
      var install = h('button', { class: 'bncm-mgr-btn', text: '安装', onclick: function () { marketInstall(p.slug); } });
      if ((p.blocked_by || []).length) {
        install.disabled = true;
        install.title = '与已安装的 ' + p.blocked_by.join('、') + ' 不兼容';
      }
      actions.appendChild(install);
    } else {
      if (p.update_available) {
        actions.appendChild(h('button', { class: 'bncm-mgr-btn', text: '更新到 ' + p.version,
          onclick: function () { marketInstall(p.slug); } }));
      }
      var del = h('button', { class: 'bncm-mgr-btn danger', text: '卸载', onclick: function () { marketUninstall(p); } });
      if (depBy.length) { del.disabled = true; del.title = '被 ' + depBy.join('、') + ' 依赖'; }
      actions.appendChild(del);
      actions.appendChild(h('button', { class: 'bncm-mgr-btn', text: '设置', onclick: function () {
        selected = p.slug; switchTab('plugins');
      } }));
    }
    if (p.repo) {
      actions.appendChild(h('button', { class: 'bncm-mgr-btn', text: '仓库', onclick: function () {
        var url = /^https?:/i.test(p.repo) ? p.repo : 'https://github.com/' + p.repo;
        try { api.ncm.openUrl(url); } catch (e) { log('openUrl failed: ' + e.message); }
      } }));
    }
    if (p.unlisted && p.installed && p.file) {
      actions.appendChild(h('button', { class: 'bncm-mgr-btn', text: '文件', title: p.installed_dir || '',
        onclick: function () {
          if (p.installed_dir) {
            // app.exec only accepts URLs, mailto: and bare drive-letter paths: pass the path itself.
            try { api.app.exec(String(p.installed_dir).replace(/\//g, '\\')); } catch (e) { /* ignore */ }
          }
        } }));
    }
    body.appendChild(actions);
    el.appendChild(body);
    return el;
  }

  function renderMarketGrid() {
    if (!panel) return;
    var grid = panel.querySelector('.bncm-mk-grid');
    if (!grid) { renderMain(); return; }
    grid.textContent = '';
    if (!market.data) {
      // The toolbar stays usable while the first read is in flight: the built-in source is on
      // disk, so this should be a sub-100 ms state, never a "the panel is thinking" state.
      grid.appendChild(h('div', { class: 'bncm-mgr-empty',
        text: market.loading ? '正在读取插件市场…' : '还没有市场数据。' }));
      return;
    }
    var view = marketVisible();
    if (!view.list.length) {
      grid.appendChild(h('div', { class: 'bncm-mgr-empty',
        text: market.category === 'update' ? '没有可更新的插件。'
            : (market.category === 'installed' ? '没有从这个市场安装的插件。' : '没有匹配的插件。') }));
      return;
    }
    var max = marketMaxDownloads();
    view.list.forEach(function (p) { grid.appendChild(marketCard(p, view.stats, max)); });
  }

  function renderMarketNotes() {
    if (!panel) return;
    var box = panel.querySelector('.bncm-mk-notes');
    if (!box) return;
    box.textContent = '';
    if (market.reload) {
      var notice = h('div', { class: 'bncm-mgr-note warn' }, [
        '插件的更改需要重载页面后生效。',
        h('button', { class: 'bncm-mgr-btn', style: { marginLeft: '8px' }, text: '立即重载',
          onclick: function () { market.reload = false; doReload(); } }),
      ]);
      box.appendChild(notice);
    }
    if (market.note) box.appendChild(h('div', { class: 'bncm-mgr-note ' + (market.note.kind || ''),
                                                text: market.note.text }));
    if (market.loading && market.data) {
      box.appendChild(h('div', { class: 'bncm-mgr-note', text: '正在读取索引…' }));
    }
    var pend = (market.data && market.data.sources ? market.data.sources : []).filter(function (s) {
      return s.pending;
    });
    if (pend.length) {
      box.appendChild(h('div', { class: 'bncm-mgr-note', text:
        '正在后台读取：' + pend.map(function (s) { return s.name; }).join('、')
        + '（读完后会自动出现在列表里，也可以用「刷新索引」立刻等它）' }));
    }
    (market.data && market.data.sources ? market.data.sources : []).forEach(function (src) {
      if (src.pending) return;
      if (src.ok === false) {
        box.appendChild(h('div', { class: 'bncm-mgr-note warn',
          text: '源「' + src.name + '」读取失败：' + src.error
              + (src.count ? '（仍在用 ' + src.count + ' 条缓存）' : '，本次没有插件来自它') }));
      }
    });
  }

  function renderSourcePanel(container) {
    var box = h('div', { class: 'bncm-mk-sources' });
    var payload = market.sources || {};
    var list = payload.sources || (market.data && market.data.sources) || [];

    box.appendChild(h('div', { class: 'bncm-mgr-meta', text:
      '源决定市场里能看到哪些插件。内置源随程序分发、离线可用；其它源需要网络。' }));

    list.forEach(function (src) {
      var row = h('div', { class: 'bncm-mk-src-row' });
      var cb = h('input', { type: 'checkbox' });
      cb.checked = src.enabled !== false;
      if (src.builtin) cb.disabled = true;
      cb.addEventListener('change', function () {
        var patch = { enabled: {} };
        patch.enabled[src.id] = cb.checked;
        marketSaveSettings(patch);
      });
      row.appendChild(h('label', { class: 'bncm-mk-check' }, [cb]));
      var report = marketSourceReport(src.id);
      var info = h('div', { class: 'bncm-mk-src-name' }, [
        h('div', {}, [
          h('span', { text: src.name }),
          src.builtin ? h('span', { class: 'bncm-mk-tag', style: { marginLeft: '6px' }, text: '内置' }) : null,
          src.custom ? h('span', { class: 'bncm-mk-tag warn', style: { marginLeft: '6px' }, text: '自定义' }) : null,
          src.trustable === false ? h('span', { class: 'bncm-mk-tag err', style: { marginLeft: '6px' }, text: '未解锁' }) : null,
        ].filter(Boolean)),
        h('div', { class: 'bncm-mk-src-base', text: src.base || '（随包目录）' }),
        report ? h('div', { class: 'bncm-mk-src-base', text:
          (report.ok ? '✓ ' + report.count + ' 个插件'
                     : '✗ ' + (report.error || '读取失败') + (report.count ? '（缓存 ' + report.count + ' 条）' : ''))
          + (report.cached ? ' · 来自缓存' : '') }) : null,
      ].filter(Boolean));
      row.appendChild(info);
      if (src.custom) {
        row.appendChild(h('button', { class: 'bncm-mgr-btn danger', text: '删除', onclick: function () {
          marketSaveSettings({ remove_source: src.id });
        } }));
      }
      box.appendChild(row);
    });

    var addInput = h('input', { class: 'bncm-mk-input', placeholder: 'https://example.com/plugins-source/' });
    box.appendChild(h('div', { class: 'bncm-mk-src-row' }, [
      addInput,
      h('button', { class: 'bncm-mgr-btn', text: '添加自定义源', onclick: function () {
        var base = addInput.value.trim();
        if (!base) return;
        marketSaveSettings({ add_source: { base: base } });
      } }),
    ]));

    var unlock = h('input', { type: 'checkbox' });
    unlock.checked = payload.custom_unlocked === true;
    unlock.addEventListener('change', function () { marketSaveSettings({ custom_unlocked: unlock.checked }); });
    box.appendChild(h('div', { class: 'bncm-mk-src-row' }, [
      h('label', { class: 'bncm-mk-check' }, [unlock, '信任自定义源（允许从上面添加的源安装插件）']),
    ]));

    var dev = h('input', { type: 'checkbox' });
    dev.checked = market.showLibs === true;
    dev.addEventListener('change', function () {
      market.showLibs = dev.checked;
      renderMain();
    });
    box.appendChild(h('div', { class: 'bncm-mk-src-row' }, [
      h('label', { class: 'bncm-mk-check' }, [dev, '显示“依赖库”分类']),
      h('button', { class: 'bncm-mgr-btn', text: '清除索引缓存', onclick: function () {
        host('/api/market/cache/clear', { method: 'POST', body: '{}' }).then(function () {
          market.previews = {};
          return loadMarket(true);
        });
      } }),
    ]));
    container.appendChild(box);
  }

  function renderMarket(main) {
    main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: '插件市场' }));
    main.appendChild(h('div', { class: 'bncm-mgr-meta', text:
      '索引格式与上游 BetterNCM 插件市场一致；内置源随程序分发，安装前会校验包与索引是否对得上。' }));

    if (market.error && !market.data) {
      main.appendChild(h('div', { class: 'bncm-mgr-note err', text: '读取市场失败：' + market.error }));
    }

    var view = marketVisible();
    var bar = h('div', { class: 'bncm-mk-bar' });
    var search = h('input', { class: 'bncm-mk-search', value: market.q,
      placeholder: '搜索名称 / slug / 作者（空格为 AND，可用 author:xxx）' });
    search.addEventListener('input', function () { market.q = search.value; renderMarketGrid(); });
    bar.appendChild(search);
    bar.appendChild(h('button', { class: 'bncm-mgr-btn', text: '源设置',
      onclick: function () { market.showSources = !market.showSources; renderMain(); } }));
    bar.appendChild(h('button', { class: 'bncm-mgr-btn', text: '刷新索引',
      onclick: function () { market.previews = {}; loadMarket(true); } }));
    main.appendChild(bar);

    var cats = [['all', '全部'], ['extension', '扩展'], ['theme', '主题'],
                ['installed', '已安装'], ['update', '有更新']];
    if (market.showLibs) cats.push(['lib', '依赖库']);
    var filters = h('div', { class: 'bncm-mk-bar' });
    filters.appendChild(marketSegment(cats, market.category, function (key) {
      market.category = market.category === key && key !== 'all' ? 'all' : key;
      renderMain();
    }));
    var sortKeys = [['composite', '综合', '真实下载量 + 新插件加成；没有统计时按 star'],
                    ['downloads', '下载量', '来自索引的 downloads 字段'],
                    ['stars', 'Star', ''], ['update', '更新时间', ''], ['name', '名称', '']];
    if (!view.stats) sortKeys = sortKeys.filter(function (k) { return k[0] !== 'downloads'; });
    filters.appendChild(marketSegment(sortKeys.map(function (k) { return [k[0], k[1], k[2]]; }), market.sort,
      function (key) {
        if (market.sort === key) market.order = market.order === 'asc' ? 'desc' : 'asc';
        else { market.sort = key; market.order = key === 'name' ? 'asc' : 'desc'; }
        renderMain();
      }));
    filters.appendChild(h('span', { class: 'bncm-mgr-meta', text:
      market.order === 'asc' ? '↑ 升序' : '↓ 降序' }));
    main.appendChild(filters);

    if (market.showSources) renderSourcePanel(main);

    main.appendChild(h('div', { class: 'bncm-mgr-meta', text:
      '共 ' + view.total + ' 个插件，当前显示 ' + view.list.length + ' 个'
      + (view.stats ? '' : '　（索引没有下载量统计，综合排序按 star）') }));

    var notes = h('div', { class: 'bncm-mk-notes' });
    main.appendChild(notes);

    var grid = h('div', { class: 'bncm-mk-grid' });
    main.appendChild(grid);
    renderMarketGrid();
    renderMarketNotes();
  }

  function renderDiagnostics(main) {
    main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: '诊断' }));
    main.appendChild(h('div', { class: 'bncm-mgr-meta',
      text: '这些是注入链上曾经出过错的地方，所以它们是被“报告”出来的，而不是被假定正确的。' }));

    var dot = h('dl', { class: 'bncm-mgr-kv' });
    function kv(k, v) {
      dot.appendChild(h('dt', { text: k }));
      dot.appendChild(h('dd', { text: String(v) }));
    }

    var inj = api.injector || {};
    kv('framework', inj.framework || '(未知)');
    kv('document-start 预载', inj.preload || '未安装（hijack / findApiFunction 将不可用）');
    kv('webpack', inj.webpack || '?');
    kv('window.React', inj.react || '?');
    kv('window.ReactDOM', inj.reactDom || '?');
    kv('legacyNativeCmder', inj.legacyNativeCmder ? '可用' : '缺失');
    kv('选择器注册表', inj.selectors ? JSON.stringify(inj.selectors) : '?');
    kv('后端', api.backend || '(无)');
    kv('NCM 版本', api.ncm ? api.ncm.getNCMVersion() : '?');
    main.appendChild(dot);

    /* ---- loader performance -------------------------------------------------
     * Adding plugins must not make the loader worse for the others.  These are the numbers that
     * say whether that held: how long the pass took, how much of it was download vs evaluation,
     * how often the main thread was handed back, and which plugins went over budget. */
    var loader = api.loader || null;
    var ls = loader && typeof loader.stats === 'function' ? loader.stats() : null;
    main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: '插件加载性能' }));
    if (!ls) {
      main.appendChild(h('div', { class: 'bncm-mgr-note warn',
        text: '加载器没有上报性能数据（framework.js 可能不是 0.4.0+）。' }));
    } else {
      var cfg = (typeof loader.config === 'object' && loader.config) || {};
      main.appendChild(h('div', { class: 'bncm-mgr-meta', text:
        '插件 ' + ls.plugins + '（成功 ' + ls.loaded + ' / 失败 ' + ls.error + ' / 跳过 ' + ls.skipped + '）' +
        '  ·  总耗时 ' + Math.round(ls.total_ms || 0) + 'ms' +
        '  ·  下载阶段 ' + Math.round(ls.fetch_phase_ms || 0) + 'ms' +
        '  ·  脚本执行 ' + Math.round(ls.eval_ms || 0) + 'ms' +
        '  ·  生命周期 ' + Math.round(ls.hook_ms || 0) + 'ms' +
        '  ·  让出主线程 ' + (ls.yields || 0) + ' 次' }));
      main.appendChild(h('div', { class: 'bncm-mgr-meta', text:
        '预算：并发下载 ' + cfg.concurrency + '  ·  下载超时 ' + cfg.fetchTimeoutMs +
        'ms  ·  让出间隔 ' + cfg.yieldBudgetMs + 'ms  ·  钩子预算 ' + cfg.slowHookMs + 'ms' }));
      if (ls.timeouts && ls.timeouts.length) {
        main.appendChild(h('div', { class: 'bncm-mgr-note err',
          text: '下载超时（已隔离，不影响其他插件）：' + ls.timeouts.join(', ') }));
      }
      (ls.failures || []).forEach(function (f) {
        main.appendChild(h('div', { class: 'bncm-mgr-note err',
          text: '✗ ' + f.slug + ' / ' + f.file + '：' + f.error }));
      });

      var per = (ls.per_plugin || []).slice()
        .sort(function (a, b) { return (b.load_ms || 0) - (a.load_ms || 0); }).slice(0, 8);
      if (per.length) {
        main.appendChild(h('div', { class: 'bncm-mgr-meta', text: '最慢的插件：' }));
        per.forEach(function (p) {
          main.appendChild(h('div', { class: 'bncm-mgr-note' + (p.slow ? ' warn' : ''), text:
            (p.core ? '[core] ' : '') + p.slug + '：' + Math.round(p.load_ms) + 'ms' +
            '（下载 ' + Math.round(p.fetch_ms) + ' · 执行 ' + Math.round(p.eval_ms) +
            ' · 钩子 ' + Math.round(p.hook_ms) + '）' +
            (p.timed_out ? '  ⏱ 超时' : '') }));
        });
      }
      var slow = (ls.slow || []).slice().sort(function (a, b) { return b.ms - a.ms; }).slice(0, 10);
      if (slow.length) {
        slow.forEach(function (s) {
          main.appendChild(h('div', { class: 'bncm-mgr-note warn',
            text: '⚠ 超出预算：' + s.slug + ' 的 ' + s.phase + ' 用了 ' + s.ms + 'ms' }));
        });
      } else {
        main.appendChild(h('div', { class: 'bncm-mgr-note', text: '没有插件超出加载预算。' }));
      }

      var pageErrors = loader.pageErrors ? loader.pageErrors() : [];
      if (pageErrors.length) {
        main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: '插件引发的页面错误' }));
        main.appendChild(h('div', { class: 'bncm-mgr-meta',
          text: '这些错误发生在某个插件是“当前插件”时，因此可以归因到具体 slug。' }));
        pageErrors.slice(-10).forEach(function (e) {
          main.appendChild(h('div', { class: 'bncm-mgr-note err',
            text: (e.slug || '(未知/空闲时)') + ' · ' + e.kind + '：' + e.message }));
        });
      }
    }

    var hj = (api.injector && api.injector.hijack) || null;
    if (hj && typeof hj.checkMissed === 'function') { try { hj.checkMissed(); } catch (e) { /* ignore */ } }
    main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: 'Hijack 规则' }));
    if (!hj) {
      main.appendChild(h('div', { class: 'bncm-mgr-note warn',
        text: '没有预载状态：document-start 注入未生效，模块级改写与歌词钩子都不会工作。' }));
    } else {
      main.appendChild(h('div', { class: 'bncm-mgr-meta', text:
        'payloads=' + hj.jsonpPayloads + '  模块=' + hj.modulesSeen +
        '  已改写=' + hj.modulesRewritten + '  规则=' + hj.rulesLoaded +
        '  缓冲=' + hj.bufferedPayloads + (hj.rulesLate ? '  (规则迟到：可能漏改首块)' : '') }));

      if (hj.applied && hj.applied.length) {
        hj.applied.forEach(function (a) {
          main.appendChild(h('div', { class: 'bncm-mgr-note', text: '✅ ' + a.id + ' → 模块 ' + a.moduleId }));
        });
      }
      if (hj.missed && hj.missed.length) {
        hj.missed.forEach(function (id) {
          main.appendChild(h('div', { class: 'bncm-mgr-note warn',
            text: '⚠ 规则未命中任何模块：' + id + '（前端包可能已更新，需要重新推导）' }));
        });
      }
      if (hj.errors && hj.errors.length) {
        hj.errors.forEach(function (e) { main.appendChild(h('div', { class: 'bncm-mgr-note err', text: e })); });
      }

      host('/api/hijacks').then(function (r) {
        if (!main.isConnected) return;                 // panel was re-rendered while we waited
        (r.rules || []).forEach(function (rule) {
          if (!rule.pending) return;
          main.appendChild(h('div', { class: 'bncm-mgr-note warn',
            text: '⏳ 待推导：' + rule.id + '（能力已声明，但 3.1.41 的匹配片段尚未确定）' }));
        });
      }, function () { /* ignore */ });
    }

    var missing = window.__BNCM_SELECTOR_MISSING__ || [];
    main.appendChild(h('h1', { class: 'bncm-mgr-h1', text: '选择器' }));
    if (!missing.length) {
      main.appendChild(h('div', { class: 'bncm-mgr-note', text: '本次会话没有选择器缺失记录。' }));
    } else {
      missing.forEach(function (m) {
        main.appendChild(h('div', { class: 'bncm-mgr-note warn',
          text: '缺少 "' + m.key + '"（已上报 ' + (m.candidates || []).length + ' 个候选）' }));
      });
    }

    main.appendChild(h('div', { class: 'bncm-mgr-note',
      text: '用户插件目录：' + ((state && state.plugins_dir) || '?')
          + '　内置插件目录：' + ((state && state.core_dir) || '?')
          + '　数据目录：' + ((state && state.data_dir) || '?') }));
    main.appendChild(h('div', { class: 'bncm-mgr-actions' }, [
      h('button', { class: 'bncm-mgr-btn', text: '刷新', onclick: function () { refresh(); } }),
      h('button', { class: 'bncm-mgr-btn', text: '重载全部插件', onclick: doReload }),
      h('button', { class: 'bncm-mgr-btn', text: '打开数据目录', onclick: function () {
        if (api.app && api.app.exec && state && state.data_dir) api.app.exec('file:///' + state.data_dir.replace(/\\/g, '/'));
        else if (api.ncm && api.ncm.openUrl && state && state.data_dir) api.ncm.openUrl('file:///' + state.data_dir.replace(/\\/g, '/'));
      } }),
    ]));
  }

  /* ---------------------------------------------------------- entry point ---- */

  /** One-line status for the panel header, built from the framework's status API.
   *
   *  This replaces the floating `#__bncm_badge__` overlay: the same facts (build, client version,
   *  core count, plugin counts, current lyric line count) are shown inside BetterNCM's own window
   *  instead of on top of the client's UI.  Falls back to what we know locally if the framework
   *  predates the API. */
  function statusLine() {
    var s = null;
    try { s = (window.betterncm && window.betterncm.status) ? window.betterncm.status() : null; }
    catch (e) { s = null; }
    if (!s) return BUILD + ' · ' + (api.build || '');
    var total = (s.coreLoaded || 0) + (s.userLoaded || 0);
    var parts = [
      BUILD,
      'NCM ' + (s.ncmVersion || '?'),
    ];
    // Only mention a core tier when one actually exists; every plugin ships as a user plugin now.
    if (s.coreTotal) parts.push('core ' + s.coreLoaded + '/' + s.coreTotal);
    parts.push('插件 ' + total + '✓' + (s.failed && s.failed.length ? ' ' + s.failed.length + '✗' : ''));
    if (s.lyrics && s.lyrics.currentLines) parts.push('歌词 ' + s.lyrics.currentLines + ' 行');
    return parts.join(' · ');
  }

  function buildPanel() {
    panel = h('div', { class: 'bncm-mgr', id: 'bncm-manager' });
    var tabs = h('div', { class: 'bncm-mgr-tabs' }, [
      h('div', { class: 'bncm-mgr-tab', 'data-tab': 'plugins', text: '插件',
        onclick: function () { switchTab('plugins'); } }),
      h('div', { class: 'bncm-mgr-tab', 'data-tab': 'market', text: '插件市场',
        onclick: function () { switchTab('market'); } }),
      h('div', { class: 'bncm-mgr-tab', 'data-tab': 'diagnostics', text: '诊断',
        onclick: function () { switchTab('diagnostics'); } }),
    ]);
    var head = h('div', { class: 'bncm-mgr-head' }, [
      h('div', {}, [
        h('div', { class: 'bncm-mgr-title', text: 'BetterNCM 插件管理' }),
        // The status that used to float over the client window bottom-right now lives here.
        h('div', { class: 'bncm-mgr-build', text: statusLine() }),
      ]),
      tabs,
      h('div', { class: 'bncm-mgr-close', text: '✕', onclick: close }),
    ]);
    panel.appendChild(head);
    panel.appendChild(h('div', { class: 'bncm-mgr-body' }, [
      h('div', { class: 'bncm-mgr-list' }),
      h('div', { class: 'bncm-mgr-main' }),
    ]));
    (document.body || document.documentElement).appendChild(panel);
    renderTabs = function () {
      var els = panel.querySelectorAll('.bncm-mgr-tab');
      for (var i = 0; i < els.length; i++) {
        els[i].classList.toggle('active', els[i].getAttribute('data-tab') === tab);
      }
    };
  }
  var renderTabs = function () {};

  function switchTab(next) {
    tab = next;
    renderTabs();
    renderList();
    renderMain();
    if (tab === 'market' && !market.data && !market.loading) loadMarket(false);
  }

  function open() {
    ensureStyles();
    if (!panel) buildPanel();
    panel.classList.add('open');
    refresh();
  }
  function close() { if (panel) panel.classList.remove('open'); }
  function toggle() { if (panel && panel.classList.contains('open')) close(); else open(); }

  /** Find the client's settings gear and hang our entry next to it.
   *
   *  Returns false when nothing identifiable was found, in which case the floating launcher is
   *  the entry point.  That is not a degraded joke: it means the manager keeps working on a
   *  frontend pack that renamed every icon class, which has already happened once. */
  function tryInlineEntry() {
    var candidates = [
      api.dom && api.dom.selector ? api.dom.selector('settingsButton') : null,
      '.cmd-icon-setting', 'a[href="#/m/setting/"]',
      '.m-top .cmd-icon', '[class*=TopBar] [class*=setting]', '[class*=titlebar] [class*=setting]',
    ].filter(Boolean);

    for (var i = 0; i < candidates.length; i++) {
      var node = null;
      try { node = document.querySelector(candidates[i]); } catch (e) { node = null; }
      if (!node || !node.parentElement) continue;
      // The client may have replaced the page since we mounted; re-insert if our button is gone.
      if (entry && entry.parentElement === node.parentElement) return true;
      if (!entry) {
        entry = h('a', {
          href: 'javascript:void(0)', title: 'BetterNCM',
          class: (node.className || '') + ' bncm-mgr-inline-entry',
          onclick: function (e) { e.preventDefault(); e.stopPropagation(); toggle(); },
        });
        entry.appendChild(h('span', { text: 'B', style: { fontWeight: '700' } }));
      }
      node.parentElement.appendChild(entry);
      log('manager entry attached next to "' + candidates[i] + '"');
      return true;
    }
    return false;
  }

  function ensureFab() {
    if (document.getElementById('bncm-mgr-fab')) return;
    var fab = h('div', {
      id: 'bncm-mgr-fab', class: 'bncm-mgr-fab', title: 'BetterNCM 插件管理',
      text: 'B', onclick: toggle,
    });
    (document.body || document.documentElement).appendChild(fab);
  }

  /* ------------------------------------------------------------- install ---- */

  function install(betterncm, opts) {
    api = betterncm;
    helpers = opts || {};
    ensureStyles();
    // Start with the user plugin list selected when there is nothing else to show, and keep
    // trying to inline the entry as the client finishes rendering its chrome.
    tryInlineEntry();
    setInterval(function () {
      if (!tryInlineEntry()) ensureFab();
    }, 4000);
    log(BUILD + ' installed');
    return true;
  }

  window.__BNCM_MANAGER__ = {
    build: BUILD,
    install: install,
    open: open,
    close: close,
    toggle: toggle,
    refresh: refresh,
    /** Structured snapshot for the diagnostics tab, the test harness and `cdp_inject` one-liners.
     *  Returning the market's own view (not a re-render) is what makes a "the panel says X but the
     *  API says Y" report answerable without guessing. */
    debug: function () {
      return {
        build: BUILD,
        tab: tab,
        selected: selected,
        market: {
          loading: market.loading,
          error: market.error,
          q: market.q,
          category: market.category,
          sort: market.sort + '/' + market.order,
          plugins: market.data ? market.data.plugins.length : null,
          sources: market.data
            ? (market.data.sources || []).map(function (s) {
                return { id: s.id, ok: s.ok, pending: s.pending, from: s.from, count: s.count,
                         error: s.error };
              })
            : null,
        },
        installed: state
          ? {
              core: (state.core || []).map(function (p) { return p.slug; }),
              user: (state.plugins || []).map(function (p) { return p.slug; }),
            }
          : null,
      };
    },
  };
})();
