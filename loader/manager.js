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
  var BUILD = 'bncm-v3-manager/0.2.0';

  var api = null;          // betterncm
  var helpers = null;      // { loadedPlugins, reload }
  var panel = null;
  var entry = null;
  var state = null;        // last /api/state payload
  var selected = null;     // slug being configured
  var tab = 'plugins';     // plugins | diagnostics
  var notes = [];          // in-panel messages

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
      h('div', { class: 'bncm-mgr-tab' + (tab === 'plugins' ? ' active' : ''), text: '插件',
        onclick: function () { tab = 'plugins'; renderTabs(); renderMain(); } }),
      h('div', { class: 'bncm-mgr-tab' + (tab === 'diagnostics' ? ' active' : ''), text: '诊断',
        onclick: function () { tab = 'diagnostics'; renderTabs(); renderMain(); } }),
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
      if (els[0]) els[0].classList.toggle('active', tab === 'plugins');
      if (els[1]) els[1].classList.toggle('active', tab === 'diagnostics');
    };
  }
  var renderTabs = function () {};

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
  };
})();
