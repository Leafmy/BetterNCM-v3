/* NCM Font Manager -- font family / size / weight manager for NetEase Cloud Music 3.1.41.
 *
 * Three independent layers, so a failure in one never breaks the others:
 *
 *   1. CSS layer    -- one <style id="bncm-font-style"> carrying a generated @font-face
 *                      (english/number overlay via local() + unicode-range) plus an explicit,
 *                      namespaced selector list for UI / body / lyric text.  MAIN WINDOW ONLY.
 *   2. Native layer -- player.setFont / player.setLRCFont.  These are the ONLY way to reach the
 *                      desktop-lyric window and the mini player; both are separate CEF windows
 *                      with their own document, so page CSS cannot touch them.
 *   3. Panel layer  -- a plain-DOM config view (no React) whose live preview renders from the very
 *                      same generated stacks, so preview and reality cannot drift.
 *
 * Idempotent: the stylesheet is keyed by id and its textContent is replaced; the panel's style
 * element is keyed by id; a re-injection disposes the previous instance through
 * window.__BNCM_NCM_FONT_MANAGER__.  The one thing a re-injection cannot fully undo is the native
 * FontSize callback registration (the client's registry is overwrite-by-name, so we occupy exactly
 * one callback name: 'player.onFontSize'); that is stated in the panel.
 *
 * Contract verified against the real 3.1.41 bundles (also recorded in README.md):
 *   AudioPlayer.getSystemFonts()        -> channel.call('os.querySystemFonts')
 *                                          => ['success', [family, ...]]
 *   AudioPlayer.getNativeSupportFonts(n)-> channel.call('os.checkNativeSupportFonts', [names])
 *   AudioPlayer.setFont(family, size)   -> channel.call('player.setFont', family, size)
 *   setDekstopLyricStyle({name:'lrcFont', value:[size, style, family]})
 *                                       -> channel.call('player.setLRCFont', size, style, family)
 *   subscribeDeskLyricFontSize(cb)      -> appendRegisterCall('FontSize','player', r => cb({size:r}))
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ boot + re-entry */

  var SLUG = 'NCM-Font-Manager';
  var VERSION = '0.1.3';
  var STYLE_ID = 'bncm-font-style';
  var PANEL_CSS_ID = 'bncm-font-panel-style';
  var PANEL_ID = 'bncm-fm-panel';
  var LIST_ID = 'bncm-fm-fonts';
  var MARKER_CLASS = 'bncm-fm';                 // on <html>; every selector we emit is under it
  var LATIN_FF = 'BNCM-Latin';                  // generated @font-face family for the latin overlay
  var CFG_PREFIX = 'cc.microblock.ncmfont.';    // durable copy in <data>/config.json
  var LS_NS = 'config.betterncm.' + SLUG;       // plugin-local copy
  var SNAPSHOT_FILE = 'FontManager/font-snapshot.json';

  var PREV = window.__BNCM_NCM_FONT_MANAGER__;
  if (PREV && typeof PREV.dispose === 'function') {
    try { PREV.dispose(); } catch (e) { /* previous instance is already broken; carry on */ }
  }

  var bncm = window.betterncm || {};
  var utils = bncm.utils || {};
  var ncmApi = bncm.ncm || {};
  var appApi = bncm.app || {};

  function log() {
    try { console.log.apply(console, ['[NCM-Font-Manager]'].concat([].slice.call(arguments))); }
    catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ DEFAULTS */

  var DEFAULTS = {
    uiFamily: '',
    uiSize: 14,
    uiWeight: 400,
    bodyFamily: '',
    bodyWeight: 400,
    lyricFamily: '',
    lyricSize: 36,
    lyricWeight: 400,
    lyricStyle: 0,               // 0 = 标准, 1 = 加粗 (the client offers exactly these two)
    latinFamily: '',
    latinIncludeCjkPunct: false,
    fallbacks: ['Microsoft YaHei', 'Segoe UI', 'PingFang SC', 'sans-serif'],
    lyricFontDefault: '默认'     // literal the client substitutes 微软雅黑 for
  };

  var WEIGHT_OPTIONS = [
    { value: 300, label: '300 细' },
    { value: 400, label: '400 常规' },
    { value: 500, label: '500 中等' },
    { value: 600, label: '600 半粗' },
    { value: 700, label: '700 粗' },
    { value: 900, label: '900 极粗' }
  ];

  var STYLE_OPTIONS = [
    { value: 0, label: '标准' },
    { value: 1, label: '加粗' }
  ];

  /* ------------------------------------------------------------------ warnings surface */

  /* "Fail loudly, never fake success": everything that can fail lands here and the panel renders
   * it.  Warnings raised before the panel exists are queued and flushed on panel build. */
  var warnings = [];
  var panelWarningBox = null;

  function firstWarn(msg) {
    if (warnings.indexOf(msg) >= 0) return;
    warnings.push(msg);
    try { console.warn('[NCM-Font-Manager] ' + msg); } catch (e) { /* ignore */ }
    renderWarnings();
  }
  function renderWarnings() {
    if (!panelWarningBox) return;
    panelWarningBox.textContent = '';
    if (!warnings.length) {
      panelWarningBox.style.display = 'none';
      return;
    }
    panelWarningBox.style.display = 'block';
    panelWarningBox.appendChild(el('b', '', { text: '警告（' + warnings.length + '）· 以下功能可能未按预期工作' }));
    var ul = el('ul', 'margin:4px 0 0;padding-left:18px');
    warnings.forEach(function (w) { ul.appendChild(el('li', '', { text: w })); });
    panelWarningBox.appendChild(ul);
  }
  function clearWarnings() {
    warnings.length = 0;
    renderWarnings();
  }

  /* ------------------------------------------------------------------ tiny DOM helper */

  function el(tag, css, props, children) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'text') e.textContent = props[k];
        else if (k === 'class') e.className = props[k];
        else e[k] = props[k];
      });
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var self = this, args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = 0; fn.apply(self, args); }, ms);
    };
  }

  /* ------------------------------------------------------------------ config persistence */

  /**
   * Precedence (documented in README.md as well):
   *
   *   app config   cc.microblock.ncmfont.<key>   in <data>/config.json   (survives cache clears)
   *     >
   *   plugin config  localStorage["config.betterncm.<slug>"].<key>
   *     >
   *   DEFAULTS
   *
   * Reads consult both stores (the durable copy is applied on top once it arrives); writes go to
   * both.  An unreachable backend is not fatal -- localStorage alone keeps the plugin working -- but
   * it is surfaced as a warning rather than swallowed.
   */
  var Preferences = (function () {
    var appWriteWarned = false;

    function rawSlugConfig() {
      try {
        var s = localStorage.getItem(LS_NS);
        var j = s ? JSON.parse(s) : null;
        if (j && typeof j === 'object') return j;
      } catch (e) { /* corrupted entry: treat as empty */ }
      return {};
    }

    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

    function normalise(key, v) {
      var def = DEFAULTS[key];
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof def === 'number') {
        var n = Number(v);
        return isFinite(n) ? n : undefined;
      }
      if (typeof def === 'boolean') {
        if (typeof v === 'boolean') return v;
        return String(v) === 'true' || String(v) === '1';
      }
      if (isArray(def)) {
        if (isArray(v)) {
          return v.filter(function (x) { return typeof x === 'string' && x.trim(); })
                  .map(function (x) { return String(x).trim(); });
        }
        if (typeof v === 'string') {
          try {
            var j = JSON.parse(v);
            if (isArray(j)) return normalise(key, j);
          } catch (e) { /* not JSON: fall through to comma splitting */ }
          return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        }
        return undefined;
      }
      return typeof v === 'string' ? v : String(v);
    }

    return {
      read: function (key) { return normalise(key, rawSlugConfig()[key]); },

      write: function (key, value) {
        var slugOk = false;
        try {
          var cfg = rawSlugConfig();
          cfg[key] = value;
          localStorage.setItem(LS_NS, JSON.stringify(cfg));
          slugOk = true;
        } catch (e) {
          firstWarn('无法写入插件配置（localStorage 不可用）：' + (e && e.message));
        }
        try {
          if (appApi && typeof appApi.writeConfig === 'function') {
            var text = isArray(value) ? JSON.stringify(value) : String(value);
            Promise.resolve(appApi.writeConfig(CFG_PREFIX + key, text)).then(function (ok) {
              if (ok === false && !appWriteWarned) {
                appWriteWarned = true;
                firstWarn('写入 ' + CFG_PREFIX + key + ' 失败：配置只保存在 localStorage，清缓存后可能丢失。');
              }
            }, function () {
              if (!appWriteWarned) {
                appWriteWarned = true;
                firstWarn('写入 ' + CFG_PREFIX + key + ' 失败（后端不可达）：配置只保存在 localStorage。');
              }
            });
          }
        } catch (e) { /* synchronous throw from a stubbed backend: ignore */ }
        return slugOk;
      },

      readAll: function () {
        var out = {};
        Object.keys(DEFAULTS).forEach(function (k) {
          var v = Preferences.read(k);
          out[k] = v === undefined ? DEFAULTS[k] : v;
        });
        return out;
      },

      /** Overlay the durable copies on top of the plugin-local ones. */
      hydrateFromApp: function (cfg) {
        if (!appApi || typeof appApi.readConfig !== 'function') return Promise.resolve(cfg);
        return Promise.all(Object.keys(DEFAULTS).map(function (k) {
          return Promise.resolve(appApi.readConfig(CFG_PREFIX + k, '')).then(function (raw) {
            if (raw === undefined || raw === null || raw === '') return null;
            var v = normalise(k, String(raw));
            return v === undefined ? null : { k: k, v: v };
          }, function () { return null; });
        })).then(function (rows) {
          rows.forEach(function (r) { if (r) cfg[r.k] = r.v; });
          return cfg;
        }, function () { return cfg; });
      },

      /** Drop exactly our keys, leaving every other plugin's settings alone. */
      clearSlugConfig: function () {
        try {
          var cfg = rawSlugConfig();
          Object.keys(DEFAULTS).forEach(function (k) { delete cfg[k]; });
          localStorage.setItem(LS_NS, JSON.stringify(cfg));
          return true;
        } catch (e) { return false; }
      },

      clearAppConfig: function () {
        if (!appApi || typeof appApi.writeConfig !== 'function') return Promise.resolve(false);
        return Promise.all(Object.keys(DEFAULTS).map(function (k) {
          return Promise.resolve(appApi.writeConfig(CFG_PREFIX + k, ''))
            .then(function () { return true; }, function () { return false; });
        })).then(function () { return true; }, function () { return false; });
      }
    };
  })();

  /* ------------------------------------------------------------------ native bridge */

  /** Promise wrapper over the client's own bridge; never rejects, resolves undefined on failure. */
  function nativeCall() {
    var args = [].slice.call(arguments);
    var cmd = args.shift();
    // Every path (boot, edits, reset, diagnostics and FontSize) must respect the owner.
    if (cmd === 'player.setLRCFont' && lyricOwner()) return Promise.resolve(undefined);
    var label = 'ncm.call(' + cmd + ')';
    try {
      if (!ncmApi || typeof ncmApi.call !== 'function') {
        firstWarn(label + ' 失败：betterncm.ncm.call 不可用（兼容层未注入？）');
        return Promise.resolve(undefined);
      }
      return Promise.resolve(ncmApi.call.apply(ncmApi, [cmd].concat(args))).then(
        function (r) { return r; },
        function (e) {
          firstWarn(label + ' 失败：' + (e && e.message ? e.message : e));
          return undefined;
        });
    } catch (e) {
      firstWarn(label + ' 抛出异常：' + (e && e.message ? e.message : e));
      return Promise.resolve(undefined);
    }
  }

  /**
   * The client's own `call` unwraps a multi-value native reply as `r.length > 1 ? r : r[0]`, so a
   * ['success', [...]] reply can arrive here either raw or already unwrapped to the payload.
   * Tolerate every shape, including the documented `undefined` reply.
   */
  function bridgePayload(r) {
    if (Array.isArray(r) && r.length && r[0] === 'success') return r[1];
    return r;
  }

  /** os.querySystemFonts -> string[]; [] means "could not determine" (and says so). */
  function querySystemFonts() {
    return nativeCall('os.querySystemFonts').then(function (r) {
      var payload = bridgePayload(r);
      if (payload === undefined || payload === null) {
        firstWarn('os.querySystemFonts 未返回数据（该命令在本机可能不受支持）——已回退到内置字体表 + 自由输入。');
        return [];
      }
      if (!Array.isArray(payload)) {
        firstWarn('os.querySystemFonts 返回了非数组结果（' + typeof payload + '）——已回退到内置字体表 + 自由输入。');
        return [];
      }
      return payload.filter(function (f) { return typeof f === 'string' && f.trim(); });
    });
  }

  /** os.checkNativeSupportFonts(names) -> the subset actually usable; never rejects. */
  function checkNativeSupportFonts(names) {
    if (!names || !names.length) return Promise.resolve([]);
    return nativeCall('os.checkNativeSupportFonts', names).then(function (r) {
      var payload = bridgePayload(r);
      if (!Array.isArray(payload)) return [];
      return payload.filter(function (f) { return typeof f === 'string' && f.trim(); });
    });
  }

  /* ------------------------------------------------------------------ font list */

  /**
   * Curated fallback list.  The first five entries are the client's own
   * getNativeSupportFonts() probe list; the rest covers the common Windows CJK faces.  Only a
   * handful are guaranteed present, so the whole set is re-checked through
   * os.checkNativeSupportFonts before being offered.
   */
  var CURATED_PROBE = ['微软雅黑', '幼圆', '楷体', '隶书', '新宋体'];
  var CURATED_EXTRA = [
    '宋体', '黑体', '等线', '仿宋', '华文中宋', '方正舒体', '方正姚体', '华文琥珀', '华文彩云',
    '华文楷体', '华文宋体', '华文细黑', '华文行楷', '汉仪篆书繁', '汉仪瘦金书', '微软雅黑 Light',
    'Source Han Sans SC', 'Source Han Serif SC', 'Noto Sans SC', 'Noto Serif SC', '思源黑体',
    '思源宋体', 'HarmonyOS Sans SC', 'LXGW WenKai', 'PingFang SC', 'Microsoft YaHei', 'SimSun',
    'SimHei', 'KaiTi', 'FangSong'
  ];
  /** Latin-centric faces offered for the english/number overlay. */
  var CURATED_LATIN = [
    'Inter', 'Roboto', 'Segoe UI', 'Calibri', 'Arial', 'Helvetica', 'Verdana', 'Tahoma',
    'Georgia', 'Times New Roman', 'Cambria', 'Consolas', 'JetBrains Mono', 'Fira Code',
    'Cascadia Code', 'Source Code Pro', 'Roboto Mono', 'Open Sans', 'Lato', 'Montserrat'
  ];

  var fontState = {
    system: [],
    cjkChecked: [],
    loaded: false,
    queryError: ''
  };

  function loadFontsOnce() {
    if (fontState.loaded) return Promise.resolve(fontState);
    fontState.loaded = true;
    return querySystemFonts().then(function (list) {
      fontState.system = list;
      if (!list.length) fontState.queryError = 'os.querySystemFonts 无结果';
      var probe = CURATED_PROBE.concat(CURATED_EXTRA)
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
      return checkNativeSupportFonts(probe).then(function (ok) {
        if (ok.length) {
          fontState.cjkChecked = ok;
        } else {
          // Not an error worth alarming about any more: os.checkNativeSupportFonts takes a single
          // name on this client and reports nothing useful in bulk, while os.querySystemFonts
          // gives us the authoritative installed list.  Only warn when we have NEITHER.
          fontState.cjkChecked = probe.slice();
          if (!fontState.system.length) {
            firstWarn('既未读到系统字体列表、os.checkNativeSupportFonts 也无结果——字体族请用「自定义…」手动输入。');
          }
        }
        return fontState;
      });
    });
  }

  /** Case-insensitive lookup into the installed set; returns the installed spelling. */
  function installedName(name) {
    var want = String(name).toLowerCase();
    for (var i = 0; i < fontState.system.length; i++) {
      if (fontState.system[i].toLowerCase() === want) return fontState.system[i];
    }
    return null;
  }

  var CJK_HINT = /[\u4E00-\u9FA5]|yahei|simsun|simhei|kaiti|fangsong|jhenghei|malgun|yu ?goth|meiryo|msjh|nsimsun|dengxian|source han|noto sans (sc|cjk)|pingfang|harmonyos|leelawadee|segoe ui symbol/i;
  var hasCjkChar = /[\u4E00-\u9FA5]/;

  /** Family names the UI offers as a dropdown, de-duplicated.
   *
   *  Only families that are ACTUALLY INSTALLED are offered.  The curated tables are no longer a
   *  list of things to show -- they are a small ordering hint (the client's own probe faces first,
   *  then the common CJK faces, then everything else alphabetically) applied to the real list from
   *  os.querySystemFonts.  Offering fonts that are not installed is how a font picker ends up
   *  silently doing nothing. */
  function offerableFamilies(kind) {
    var out = [];
    function push(f) { if (f && out.indexOf(f) < 0) out.push(f); }
    function pushIfInstalled(name) { var real = installedName(name); if (real) push(real); }
    var sys = fontState.system.slice();

    if (kind === 'latin') {
      CURATED_LATIN.forEach(pushIfInstalled);
      sys.filter(function (f) { return !CJK_HINT.test(f); }).sort().forEach(push);
      sys.filter(function (f) { return CJK_HINT.test(f); }).sort().forEach(push);
      return out;
    }

    // CJK / general: the client's own probe faces, then the curated CJK names, then the rest.
    CURATED_PROBE.forEach(pushIfInstalled);
    CURATED_EXTRA.forEach(pushIfInstalled);
    sys.filter(function (f) { return hasCjkChar.test(f) || CJK_HINT.test(f); }).sort().forEach(push);
    sys.filter(function (f) { return !hasCjkChar.test(f) && !CJK_HINT.test(f); }).sort().forEach(push);
    return out;
  }

  /** Every family control registers here so they can be refilled once the installed list arrives
   *  (the panel is built synchronously, the bridge reply is not). */
  var familyControls = [];

  function refreshFamilyControls() {
    for (var i = 0; i < familyControls.length; i++) {
      try { familyControls[i].fill(); } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ the generated CSS */

  function quoteFamily(f) {
    return "'" + String(f).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  function splitCommaList(s) {
    return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /**
   * The ordered stack used everywhere: the latin overlay first (latin and number glyphs come from
   * it), then the base family, then the user fallbacks.
   */
  function stackFor(cfg, baseFamily) {
    var parts = [];
    if (cfg.latinFamily) parts.push(quoteFamily(LATIN_FF));
    var base = baseFamily && baseFamily !== '默认' ? baseFamily : '';
    splitCommaList(base).concat(cfg.fallbacks || []).forEach(function (f) {
      var q = (f === LATIN_FF) ? '' : f;
      if (q && parts.indexOf(quoteFamily(q)) < 0) parts.push(quoteFamily(q));
    });
    if (!parts.length) parts.push(quoteFamily('Microsoft YaHei'));
    return { parts: parts, body: parts.join(', ') };
  }

  var LATIN_BASE_RANGES = [
    'U+0020-024F', 'U+2000-206F', 'U+20A0-20CF', 'U+2100-214F',
    'U+2190-21FF', 'U+2200-22FF', 'U+2460-24FF', 'U+25A0-25FF', 'U+2600-26FF'
  ];
  /* Config knob, default OFF: fullwidth CJK punctuation.  When enabled the ranges are prepended so
   * the overlay claims those code points; otherwise they keep the base CJK family. */
  var LATIN_CJK_PUNCT_RANGES = ['U+3000-303F', 'U+FF00-FFEF'];

  function unicodeRange(cfg) {
    return (cfg.latinIncludeCjkPunct ? LATIN_CJK_PUNCT_RANGES : []).concat(LATIN_BASE_RANGES).join(',');
  }

  /**
   * MAIN-WINDOW selectors only, written as an explicit list under our own <html> marker class.
   * No :where() anywhere: it zeroes specificity, which would lose to the client's inline styles --
   * exactly what we need !important for in the first place.
   */
  var UI_SELECTORS = [
    'html.bncm-fm [class*="LeftScrollContainer_"]',
    'html.bncm-fm .cmd-button',
    'html.bncm-fm .cmd-input',
    'html.bncm-fm .cmd-select',
    'html.bncm-fm .m-top',
    'html.bncm-fm header.g-hd',
    'html.bncm-fm .m-winctrl',
    'html.bncm-fm [class^="TitleBar"]',
    'html.bncm-fm [class^="Sidebar"]',
    'html.bncm-fm [class^="Nav"]',
    'html.bncm-fm [class^="Search"]',
    'html.bncm-fm [class^="MenuItem"]',
    'html.bncm-fm [class^="TabItem"]',
    'html.bncm-fm [class^="Button"]',
    'html.bncm-fm [class^="Btn"]',
    'html.bncm-fm [class^="SettingItem"]',
    'html.bncm-fm [class^="Switch"]',
    'html.bncm-fm .u-ibtn5',
    'html.bncm-fm .u-btn2',
    'html.bncm-fm .u-txt'
  ];

  var BODY_SELECTORS = [
    'html.bncm-fm body',
    'html.bncm-fm [class^="RightContainer_"]',
    'html.bncm-fm [class*="AppScrollContainer"]',
    'html.bncm-fm [class^="MainContent"]',
    'html.bncm-fm #main-player',
    'html.bncm-fm .m-pinfo',
    'html.bncm-fm .g-mn',
    'html.bncm-fm .g-mn'
  ];

  /**
   * Lyric selectors, including the RefinedNowPlaying nodes (that plugin replaces the player page
   * DOM when it is active).  The loose [class*=lyric]/[class*=Lyric] pair sits last so the precise
   * selectors above win, while still catching hashed names this build did not have.
   */
  var LYRIC_SELECTORS = [
    'html.bncm-fm [class^="LyricWrapper_"]',
    'html.bncm-fm [class*=LyricDisplayInnerContainer]',
    'html.bncm-fm [class*=ScrollableLyricDisplayContainer]',
    'html.bncm-fm [class*=LyricDefaultPageContainer]',
    'html.bncm-fm [class*=LyricContainer_]',
    'html.bncm-fm [class*=LyricDisplayContainer]',
    'html.bncm-fm .rnp-lyrics',
    'html.bncm-fm .rnp-lyrics-line',
    'html.bncm-fm .rnp-lyrics-overview-container',
    'html.bncm-fm .rnp-lyrics-overview-line',
    'html.bncm-fm [class*=lyric]',
    'html.bncm-fm [class*=Lyric]'
  ].map(function (selector) { return selector + ':not(body):not(html)'; });

  function lyricOwner() {
    var states = (window.__BNCM_LOADED__ && window.__BNCM_LOADED__.plugins) || [];
    var names = Object.keys(window.loadedPlugins || {});
    states.forEach(function (p) {
      if (!p.disabled && (p.state === 'loaded' || p.state === 'loading')) names.push(p.slug);
    });
    var owner = names.filter(function (name) {
      return name !== SLUG && /now[-_ ]?playing|lyricbar|lyric.*font|font.*lyric/i.test(name);
    }).sort(function (a, b) {
      return Number(/now[-_ ]?playing/i.test(b)) - Number(/now[-_ ]?playing/i.test(a));
    })[0];
    if (owner) return owner;
    if (document.querySelector('.rnp-lyrics,.rnp-lyrics-line')) return 'NowPlaying';
    // Also recognize custom/plugin styles without depending on their plugin name.
    // External client stylesheets are intentionally not treated as another plugin.
    function hasLyricFont(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.selectorText && r.selectorText.indexOf('html.bncm-fm') < 0 && /lyric/i.test(r.selectorText) && r.style &&
            (r.style.fontFamily || r.style.font)) return true;
        if (r.cssRules && hasLyricFont(r.cssRules)) return true;
      }
      return false;
    }
    var styles = document.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var node = styles[i];
      if (node.id === STYLE_ID || node.id === PANEL_CSS_ID || !node.sheet || node.sheet.disabled) continue;
      try {
        if (hasLyricFont(node.sheet.cssRules)) return node.id || '其他歌词字体样式';
      } catch (e) { /* inaccessible stylesheet */ }
    }
    return '';
  }

  // A declared font on a child wins over an inherited !important font on its parent.
  // NCM 3's TypographyWrapper and controls declare their own font, so target descendants too.
  // Leave icon fonts and SVG text alone; pseudo-elements keep their original icon styles.
  function fontTargets(selectors, protectLyrics) {
    var textOnly = ':not(i):not(svg):not(svg *):not([class*="icon"]):not([class*="Icon"]):not([class*="fa-"])';
    if (protectLyrics) {
      textOnly += ':not([data-bncm-fm-lyrics-owned]):not([data-bncm-fm-lyrics-owned] *)';
    }
    return selectors.map(function (s) {
      return s + textOnly + ',\n' + s + ' *' + textOnly;
    }).join(',\n');
  }

  function buildCss(cfg) {
    var ui = stackFor(cfg, cfg.uiFamily);
    var body = stackFor(cfg, cfg.bodyFamily || cfg.uiFamily);
    var lyric = stackFor(cfg, cfg.lyricFamily);
    var css = [];
    var owner = lyricOwner();

    if (cfg.latinFamily) {
      css.push('/* english/number overlay: local() + unicode-range, no DOM rewriting */');
      css.push('@font-face{font-family:\'' + LATIN_FF + '\';src:local(' + quoteFamily(cfg.latinFamily) +
        ');unicode-range:' + unicodeRange(cfg) + ';}');
    }

    css.push(':root,html.bncm-fm{');
    css.push('  --bncm-fm-ui-stack:' + ui.body + ';');
    css.push('  --bncm-fm-body-stack:' + body.body + ';');
    css.push('  --bncm-fm-lyric-stack:' + lyric.body + ';');
    css.push('}');

    css.push(fontTargets(BODY_SELECTORS, owner) + '{font-family:' + body.body + ' !important;font-weight:' + cfg.bodyWeight + ' !important;}');
    css.push(fontTargets(UI_SELECTORS, owner) + '{font-family:' + ui.body + ' !important;font-weight:' + cfg.uiWeight + ' !important;}');
    if (!owner) css.push(fontTargets(LYRIC_SELECTORS) + '{font-family:' + lyric.body + ' !important;font-weight:' + cfg.lyricWeight + ' !important;}');

    /* The client sets document.body.style.fontFamily / fontSize inline, so the body rule needs
     * !important.  Descendants are left alone on purpose: a blanket rule would fight the client's
     * own per-component sizes. */
    css.push('html.bncm-fm body{font-size:' + cfg.uiSize + 'px !important;}');

    /* The config panel must never inherit the fonts it is managing, or a bad setting would make the
     * panel unreadable and un-fixable. */
    css.push('html.bncm-fm #' + PANEL_ID + ',html.bncm-fm #' + PANEL_ID + ' *{' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif !important;}');
    ['ui', 'body', 'lyric'].forEach(function (kind) {
      var family = kind === 'body' ? (cfg.bodyFamily || cfg.uiFamily) : cfg[kind + 'Family'];
      css.push('html.bncm-fm #' + PANEL_ID + ' [data-bncm-fm-preview="' + kind + '"]{' +
        'font-family:' + stackFor(cfg, family).body + ' !important;' +
        'font-weight:' + cfg[kind + 'Weight'] + ' !important;}');
    });

    return css.join('\n');
  }

  function addMarkerClass() {
    try { document.documentElement.classList.add(MARKER_CLASS); } catch (e) { /* ignore */ }
  }
  function removeMarkerClass() {
    try { document.documentElement.classList.remove(MARKER_CLASS); } catch (e) { /* ignore */ }
  }

  function applyCss(cfg) {
    syncLyricProtection();
    var css = buildCss(cfg);
    var node = document.getElementById(STYLE_ID);
    if (!node) {
      node = document.createElement('style');
      node.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(node);
    }
    if (node.textContent !== css) node.textContent = css;
    return node;
  }

  function removeCss() {
    var node = document.getElementById(STYLE_ID);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /* ------------------------------------------------------------------ apply to the client */

  var applySeq = 0;
  var applyGeneration = 0;   // bumped by restoreDefaults so in-flight applies become no-ops
  var lastNativeApply = null;
  var lastUiRequest = '';
  var lastLyricRequest = '';

  function applyToClient(cfg) {
    var seq = ++applySeq;
    var gen = applyGeneration;
    var family = cfg.uiFamily || cfg.lyricFontDefault || '默认';
    var lyricFamily = cfg.lyricFamily || cfg.lyricFontDefault || '默认';
    var requests = [];
    var uiRequest = JSON.stringify([family, cfg.uiSize]);
    var lyricRequest = JSON.stringify([cfg.lyricSize, cfg.lyricStyle, lyricFamily]);
    if (uiRequest !== lastUiRequest) {
      lastUiRequest = uiRequest;
      requests.push(nativeCall('player.setFont', family, cfg.uiSize));
    }
    if (!lyricOwner() && lyricRequest !== lastLyricRequest) {
      lastLyricRequest = lyricRequest;
      requests.push(nativeCall('player.setLRCFont', cfg.lyricSize, cfg.lyricStyle, lyricFamily));
    }
    return Promise.all(requests).then(function () {
      if (gen !== applyGeneration) return null;   // a restore superseded this apply
      if (seq === applySeq) {
        lastNativeApply = { at: Date.now(), font: family, size: cfg.uiSize,
                            lyricFont: lyricFamily, lyricSize: cfg.lyricSize, lyricStyle: cfg.lyricStyle };
      }
      return lastNativeApply;
    }, function (e) {
      firstWarn('原生字体调用失败：' + (e && e.message ? e.message : e));
      return null;
    });
  }

  /* ------------------------------------------------------------------ applied / snapshot */

  /* The client exposes a setter for every desktop-lyric style field but no getter, so "the current
   * desktop-lyric font" cannot be read back.  We therefore record what we set as `applied`, and both
   * the snapshot and the diagnostic label that value honestly instead of presenting it as a read. */
  var APPLIED_KEY = LS_NS + '.applied';

  function readApplied() {
    try {
      var s = localStorage.getItem(APPLIED_KEY);
      var j = s ? JSON.parse(s) : null;
      return (j && typeof j === 'object') ? j : {};
    } catch (e) { return {}; }
  }
  function writeApplied(patch) {
    try {
      var cur = readApplied();
      Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
      localStorage.setItem(APPLIED_KEY, JSON.stringify(cur));
    } catch (e) { /* ignore */ }
  }

  /** Snapshot the state the client is in right now, BEFORE the first apply. */
  function captureSnapshot() {
    var applied = readApplied();
    var bodyFF = '', bodyFS = '', ffSource = 'computed', fsSource = 'computed';
    try {
      if (document.body) {
        if (document.body.style.fontFamily) { bodyFF = document.body.style.fontFamily; ffSource = 'inline'; }
        if (document.body.style.fontSize) { bodyFS = document.body.style.fontSize; fsSource = 'inline'; }
        var cs = window.getComputedStyle(document.body);
        if (!bodyFF) bodyFF = cs.fontFamily || '';
        if (!bodyFS) bodyFS = cs.fontSize || '';
      }
    } catch (e) { /* leave blanks; the diagnostic reports them as unknown */ }
    return {
      bodyFontFamily: bodyFF,
      bodyFontSize: bodyFS,
      bodyFontFamilySource: ffSource,
      bodyFontSizeSource: fsSource,
      lyricFont: applied.lyricFont === undefined ? '默认' : applied.lyricFont,
      lyricFontSize: applied.lyricFontSize === undefined ? 36 : applied.lyricFontSize,
      lyricFontStyle: applied.lyricFontStyle === undefined ? 0 : applied.lyricFontStyle,
      lyricFontSource: applied.lyricFont === undefined
        ? 'client default (the client exposes no reader for the desktop-lyric font)'
        : 'last value this plugin set (not read back from the client)',
      capturedAt: new Date().toISOString(),
      plugin: SLUG,
      pluginVersion: VERSION
    };
  }

  var snapshot = null;
  function ensureSnapshot() {
    if (snapshot) return snapshot;
    var stored = null;
    try {
      var s = localStorage.getItem(LS_NS + '.snapshot');
      stored = s ? JSON.parse(s) : null;
    } catch (e) { stored = null; }
    if (stored && typeof stored === 'object') {
      snapshot = stored;
    } else {
      snapshot = captureSnapshot();
      writeStoredSnapshot(snapshot);
      log('snapshot captured on first enable:', snapshot);
    }
    return snapshot;
  }
  function writeStoredSnapshot(snap) {
    try { localStorage.setItem(LS_NS + '.snapshot', JSON.stringify(snap)); } catch (e) { /* ignore */ }
    try {
      if (bncm.fs && typeof bncm.fs.writeFileText === 'function') {
        Promise.resolve(bncm.fs.writeFileText(SNAPSHOT_FILE, JSON.stringify(snap, null, 1)))
          .then(function () {}, function () { /* best effort */ });
      }
    } catch (e) { /* ignore */ }
  }

  function snapshotDiff(cfg) {
    var snap = ensureSnapshot() || {};
    return [
      ['bodyFontFamily', snap.bodyFontFamily, stackFor(cfg, cfg.bodyFamily || cfg.uiFamily).body],
      ['bodyFontSize', snap.bodyFontSize, cfg.uiSize + 'px'],
      ['lyricFont', snap.lyricFont, cfg.lyricFamily || cfg.lyricFontDefault],
      ['lyricFontSize', snap.lyricFontSize, cfg.lyricSize],
      ['lyricFontStyle', snap.lyricFontStyle, cfg.lyricStyle]
    ].map(function (r) {
      return { key: r[0], snapshot: r[1], current: r[2], same: String(r[1]) === String(r[2]) };
    });
  }

  function restoreDefaults() {
    var snap = ensureSnapshot() || {};
    /* 0. Invalidate everything already queued or in flight: a debounced applyAll firing after this
     * would silently re-create the stylesheet we are about to remove, and stale native calls could
     * undo the restore.  suppressApplyAll also blocks the FontSize handler while we work. */
    runtime.suppressApplyAll = true;
    lastUiRequest = '';
    lastLyricRequest = '';
    applyGeneration++;
    cancelScheduledApply();
    cfg = Preferences.readAll();
    /* 1. drop our marker class and stylesheet first, so nothing of ours can survive the restore. */
    removeMarkerClass();
    removeCss();
    clearLyricProtection();
    /* 2/3. native restore.  '默认' is the literal the client substitutes 微软雅黑 for; the size is
     * the snapshot's body font size when we captured one, otherwise the documented default 14. */
    var size = Number(String(snap.bodyFontSize || '').replace('px', '')) || DEFAULTS.uiSize;
    var lsize = (typeof snap.lyricFontSize === 'number' && isFinite(snap.lyricFontSize))
      ? snap.lyricFontSize : DEFAULTS.lyricSize;
    var lstyle = (typeof snap.lyricFontStyle === 'number') ? snap.lyricFontStyle : DEFAULTS.lyricStyle;
    return Promise.all([
      nativeCall('player.setFont', '默认', size),
      nativeCall('player.setLRCFont', lsize, lstyle, '默认')
    ]).then(function () {
      /* 4. clear our stored config in both stores.  The snapshot is kept on purpose -- the
       * diagnostic needs something to diff against. */
      Preferences.clearSlugConfig();
      try { localStorage.removeItem(APPLIED_KEY); } catch (e) { /* ignore */ }
      return Preferences.clearAppConfig().then(function () {
        clearWarnings();
        log('restored defaults (size=' + size + ', lyricSize=' + lsize + ', style=' + lstyle + ')');
        return true;
      });
    }, function (e) {
      firstWarn('恢复默认失败：' + (e && e.message ? e.message : e));
      return false;
    });
  }

  /* ------------------------------------------------------------------ runtime state */

  var runtime = {
    panel: null,
    preview: null,
    sections: {},          // name -> repaint function
    suppressApplyAll: false
  };

  var cfg = DEFAULTS;

  /* ------------------------------------------------------------------ preview */

  function buildPreview() {
    var wrap = el('div', 'border:1px dashed rgba(128,128,128,.5);border-radius:8px;padding:10px 12px');
    wrap.appendChild(el('div', 'font-size:11px;opacity:.7;margin-bottom:8px', {
      text: '实时预览 · 使用与主窗口完全相同的字体栈；任何改动都会同时应用到真实界面'
    }));
    var uiLine = el('div', '', { text: 'UI 控件示例 · 收藏 播放 下载 评论 (1234)' });
    var bodyLine = el('div', 'margin:8px 0', {
      text: '正文示例：这是一段歌曲简介/评论正文，用于检查中文与英文 ABC abc 1234567890 的观感。'
    });
    var lyricLine = el('div', '', { text: '歌词示例 · I will always love you 直到世界尽头 2024' });
    uiLine.setAttribute('data-bncm-fm-preview', 'ui');
    bodyLine.setAttribute('data-bncm-fm-preview', 'body');
    lyricLine.setAttribute('data-bncm-fm-preview', 'lyric');
    wrap.appendChild(uiLine);
    wrap.appendChild(bodyLine);
    wrap.appendChild(lyricLine);
    return { root: wrap, uiLine: uiLine, bodyLine: bodyLine, lyricLine: lyricLine };
  }

  function paintPreview() {
    var p = runtime.preview;
    if (!p) return;
    p.uiLine.style.fontFamily = stackFor(cfg, cfg.uiFamily).body;
    p.uiLine.style.fontWeight = String(cfg.uiWeight);
    p.uiLine.style.fontSize = cfg.uiSize + 'px';
    p.bodyLine.style.fontFamily = stackFor(cfg, cfg.bodyFamily || cfg.uiFamily).body;
    p.bodyLine.style.fontWeight = String(cfg.bodyWeight);
    p.bodyLine.style.fontSize = cfg.uiSize + 'px';
    p.lyricLine.style.fontFamily = stackFor(cfg, cfg.lyricFamily).body;
    p.lyricLine.style.fontWeight = String(cfg.lyricWeight);
    p.lyricLine.style.fontSize = cfg.lyricSize + 'px';
  }

  /* ------------------------------------------------------------------ apply pipeline */

  /** Debounced (~100 ms) full re-apply: stylesheet + native + preview. */
  var applyAllTimer = 0;
  function applyAll() {
    if (applyAllTimer) clearTimeout(applyAllTimer);
    applyAllTimer = setTimeout(function () {
      applyAllTimer = 0;
      if (runtime.suppressApplyAll) return;
      addMarkerClass();
      applyCss(cfg);
      paintPreview();
      if (!lyricOwner()) writeApplied({ lyricFont: cfg.lyricFamily || cfg.lyricFontDefault,
                     lyricFontSize: cfg.lyricSize, lyricFontStyle: cfg.lyricStyle });
      applyToClient(cfg);
    }, 100);
  }

  /** Drop a queued (not yet run) debounced apply. */
  function cancelScheduledApply() {
    if (applyAllTimer) { clearTimeout(applyAllTimer); applyAllTimer = 0; }
  }

  function setCfg(key, value, opts) {
    cfg[key] = value;
    Preferences.write(key, value);
    if (opts && opts.follow && opts.follow !== key) {
      cfg[opts.follow] = value;
      Preferences.write(opts.follow, value);
    }
    if (runtime.sections[key]) runtime.sections[key]();
    if (!opts || opts.quiet !== true) applyAll();
  }

  /** Release the restore latch and re-read config (used by the panel after a restore). */
  function afterRestore() {
    runtime.suppressApplyAll = false;
    cfg = Preferences.readAll();
    paintPreview();
  }

  /* ------------------------------------------------------------------ panel widgets */

  function row(labelText, controls) {
    var r = el('div', 'display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap');
    if (labelText) r.appendChild(el('span', 'min-width:112px;opacity:.7', { text: labelText }));
    (controls || []).forEach(function (c) { if (c) r.appendChild(c); });
    return r;
  }

  /** Font-family control: a real dropdown of installed families, plus an escape hatch.
   *
   *  It used to be a free-text box with a <datalist>, because os.querySystemFonts appeared to
   *  return nothing usable.  That was a bug one layer down (the bridge reply is
   *  ['success', [names]] and the loader was resolving only the first argument), fixed in
   *  loader/framework.js.  Now that the installed list is really available, the picker offers it
   *  directly:
   *
   *    （默认） / <installed families> / 自定义…
   *
   *  "自定义…" reveals a text input, so a family that is installed without being enumerable can
   *  still be typed by hand.  The current value is always kept selectable, even if it is not in the
   *  list, so opening the panel never silently rewrites the user's setting. */
  function familyInput(kind, key, follow) {
    var wrap = el('span', 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap');
    var select = document.createElement('select');
    select.style.cssText = 'min-width:220px;max-width:340px;padding:3px 6px;border-radius:6px';
    select.setAttribute('data-bncm-fm', key);          // legacy marker kept for tests/probes
    select.setAttribute('data-bncm-fm-select', kind);
    var custom = el('input', 'display:none;min-width:180px;padding:3px 6px;border-radius:6px;' +
      'border:1px solid rgba(128,128,128,.45);background:rgba(128,128,128,.08)', { value: '' });
    custom.setAttribute('data-bncm-fm-custom', key);
    custom.setAttribute('list', LIST_ID);      // autocomplete while typing a custom family

    function commit(value) {
      setCfg(key, String(value == null ? '' : value).trim(), follow ? { follow: follow } : undefined);
    }

    function fill() {
      var list = offerableFamilies(kind);
      var cur = String(cfg[key] || '');
      var opts = [{ v: '__default__', label: '（默认）' }];
      if (cur && list.indexOf(cur) < 0) opts.push({ v: cur, label: cur + '（当前）' });
      for (var i = 0; i < list.length; i++) opts.push({ v: list[i], label: list[i] });
      opts.push({ v: '__custom__', label: '自定义…' });

      select.innerHTML = '';
      opts.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.v;
        opt.textContent = o.label;
        select.appendChild(opt);
      });
      select.value = cur || '__default__';
      custom.value = cur;
      select.title = list.length + ' 个已安装字体可供选择';
    }

    select.addEventListener('change', function () {
      var v = select.value;
      if (v === '__custom__') {
        custom.style.display = '';
        commit(custom.value);
        try { custom.focus(); } catch (e) { /* ignore */ }
        return;
      }
      custom.style.display = 'none';
      commit(v === '__default__' ? '' : v);
    });
    custom.addEventListener('input', function () { commit(custom.value); });

    familyControls.push({ kind: kind, fill: fill });
    fill();
    wrap.appendChild(select);
    wrap.appendChild(custom);
    return wrap;
  }

  function numberInput(key, min, max) {
    var input = el('input', 'width:76px', {
      type: 'number', value: String(cfg[key]), min: String(min), max: String(max)
    });
    input.setAttribute('data-bncm-fm', key);
    input.addEventListener('input', function () {
      var n = Number(input.value);
      setCfg(key, isFinite(n) && n > 0 ? n : DEFAULTS[key]);
    });
    return input;
  }

  function selectBox(key, options) {
    var s = document.createElement('select');
    s.style.cssText = 'padding:3px 6px;border-radius:6px';
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.label;
      if (String(o.value) === String(cfg[key])) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', function () { setCfg(key, Number(s.value)); });
    return s;
  }

  function button(text, onClick) {
    var b = document.createElement('a');
    b.className = 'u-ibtn5';
    b.style.cssText = 'cursor:pointer;margin:.2em .4em;user-select:none';
    b.textContent = text;
    b.addEventListener('click', function (ev) { ev.preventDefault(); onClick(ev); });
    return b;
  }

  function clearButton(key, label, follow) {
    return button(label || '清除（用默认）', function () {
      setCfg(key, key === 'fallbacks' || key === 'latinIncludeCjkPunct' ? DEFAULTS[key] : '',
        follow ? { follow: follow } : undefined);
    });
  }

  function panelCss() {
    var css = [
      '#' + PANEL_ID + '{font-size:12px;line-height:1.7;max-width:860px}',
      '#' + PANEL_ID + ' .bncm-fm-sec{margin:10px 0;padding:10px 12px;border:1px solid rgba(128,128,128,.28);border-radius:8px}',
      '#' + PANEL_ID + ' .bncm-fm-sec>h4{margin:0 0 6px;font-size:13px}',
      '#' + PANEL_ID + ' .bncm-fm-note{opacity:.65;font-size:11px}',
      '#' + PANEL_ID + ' .bncm-fm-warn{background:rgba(220,60,60,.12);border-color:rgba(220,60,60,.55);display:none}',
      '#' + PANEL_ID + ' .bncm-fm-fb{display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap}',
      '#' + PANEL_ID + ' .bncm-fm-fb code{background:rgba(128,128,128,.14);padding:1px 5px;border-radius:4px}',
      '#' + PANEL_ID + ' .bncm-fm-scope{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;margin-left:6px}',
      '#' + PANEL_ID + ' .bncm-fm-main{background:rgba(60,160,90,.20)}',
      '#' + PANEL_ID + ' .bncm-fm-native{background:rgba(60,120,220,.20)}',
      '#' + PANEL_ID + ' pre{max-height:240px;overflow:auto;background:rgba(128,128,128,.12);' +
        'padding:8px;border-radius:6px;white-space:pre-wrap;margin:6px 0 0}'
    ].join('\n');
    var node = document.getElementById(PANEL_CSS_ID);
    if (!node) {
      node = document.createElement('style');
      node.id = PANEL_CSS_ID;
      (document.head || document.documentElement).appendChild(node);
    }
    if (node.textContent !== css) node.textContent = css;
  }

  function scopeTag(text, native) {
    return el('span', 'bncm-fm-scope ' + (native ? 'bncm-fm-native' : 'bncm-fm-main'), { text: text });
  }

  /* ------------------------------------------------------------------ panel sections */

  function sectionLimit() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '适用范围（必读）' }));
    sec.appendChild(el('div', '', {
      text: '桌面歌词窗口与迷你播放器是独立的 CEF 窗口，页面 CSS 无法触及，只有原生命令 ' +
        'player.setLRCFont / player.setFont 能影响它们。因此：字重、字体回退、英文/数字专用字体' +
        '这三项【只对主窗口生效】；桌面歌词只能接受「字体族 + 字号 + 加粗」三个参数。标注为' +
        '「主窗口 CSS」的项都不会影响桌面歌词。'
    }));
    sec.appendChild(row('', [scopeTag('主窗口 CSS', false), scopeTag('原生命令（含桌面歌词）', true)]));
    return sec;
  }

  function sectionUi() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '4. UI 字体（界面控件）' }));
    sec.appendChild(row('字体族', [
      familyInput('cjk', 'uiFamily', 'lyricFamily'),
      clearButton('uiFamily', '清除（用默认）', 'lyricFamily')
    ]));
    sec.appendChild(row('字重', [selectBox('uiWeight', WEIGHT_OPTIONS)]));
    sec.appendChild(row('字号 (px)', [numberInput('uiSize', 9, 40)]));
    sec.appendChild(el('div', 'bncm-fm-note', {
      text: '同时走两条路径：player.setFont(family, size) 以及注入的 font-family !important（用于压过客户端的内联样式）。'
    }));
    return sec;
  }

  function sectionBody() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '3. 正文字体 / 字重' }));
    sec.appendChild(row('正文字体族', [
      familyInput('cjk', 'bodyFamily'),
      clearButton('bodyFamily')
    ]));
    sec.appendChild(row('正文字重', [selectBox('bodyWeight', WEIGHT_OPTIONS)]));
    return sec;
  }

  function sectionLyric() {
    var sec = el('div', 'bncm-fm-sec');
    var status = el('div', 'margin:6px 0;color:#c88b36', { text: lyricStatusText() });
    status.setAttribute('data-bncm-fm-lyric-owner', '');
    sec.appendChild(status);
    sec.appendChild(el('h4', '', { text: '5. 歌词字体' }));
    sec.appendChild(row('歌词字体族', [
      familyInput('cjk', 'lyricFamily'),
      clearButton('lyricFamily')
    ]));
    sec.appendChild(row('歌词字号 (px)', [numberInput('lyricSize', 12, 96)]));
    sec.appendChild(row('歌词字重（仅主窗口 CSS）', [selectBox('lyricWeight', WEIGHT_OPTIONS)]));
    sec.appendChild(row('桌面歌词粗细（原生命令）', [selectBox('lyricStyle', STYLE_OPTIONS)]));
    sec.appendChild(el('div', '', {
      text: '两条路径同时生效：① player.setLRCFont(字号, 粗细, 字体族) —— 唯一能作用到桌面歌词窗口的方式；' +
        '② 注入 CSS，作用于应用内歌词节点（含 RefinedNowPlaying 的 rnp-* 节点）。'
    }));
    sec.appendChild(el('div', 'bncm-fm-note', {
      text: '桌面歌词只接受字体族 / 字号 / 加粗三项；上面的字重滑杆与第 6 节回退链对桌面歌词无效。'
    }));
    return sec;
  }

  function sectionLatin() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '6. 英文 / 数字字体' }));
    sec.appendChild(row('字体族', [
      familyInput('latin', 'latinFamily'),
      clearButton('latinFamily', '清除')
    ]));
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!cfg.latinIncludeCjkPunct;
    cb.addEventListener('change', function () { setCfg('latinIncludeCjkPunct', !!cb.checked); });
    sec.appendChild(row('全角 CJK 标点', [
      cb,
      el('span', 'bncm-fm-note', {
        text: '勾选后 unicode-range 追加 U+3000-303F / U+FF00-FFEF（默认不勾选：中文标点保留基础字体）'
      })
    ]));
    sec.appendChild(el('div', 'bncm-fm-note', {
      text: '实现方式：生成 @font-face{font-family:"' + LATIN_FF + '";src:local("<所选字体>");unicode-range:…}，' +
        '再把生效字体栈设为 "' + LATIN_FF + '", 基础字体族, 回退… —— 不重写任何 DOM。'
    }));
    return sec;
  }

  function sectionFallbacks() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '7. 字体回退（按顺序参与 CSS 字体栈）' }));
    sec.appendChild(el('div', 'bncm-fm-note', {
      text: '回退链只影响主窗口 CSS；桌面歌词窗口与迷你播放器由原生命令决定，回退链对其无效。'
    }));
    var listBox = el('div', 'margin:6px 0');
    sec.appendChild(listBox);

    function paint() {
      listBox.textContent = '';
      var input = el('input', 'flex:1;min-width:220px;padding:3px 6px;border-radius:6px;' +
        'border:1px solid rgba(128,128,128,.45);background:rgba(128,128,128,.08)');
      input.setAttribute('list', LIST_ID);
      input.setAttribute('placeholder', '输入字体族名，例如 HarmonyOS Sans SC');
      var line = el('div', 'bncm-fm-fb');
      line.appendChild(input);
      line.appendChild(button('添加', function () {
        var v = String(input.value || '').trim();
        if (!v) return;
        var next = (cfg.fallbacks || []).slice();
        if (next.indexOf(v) >= 0) { firstWarn('回退列表里已经有 ' + v + '。'); return; }
        cfg.fallbacks = next.concat([v]);
        Preferences.write('fallbacks', cfg.fallbacks);
        applyAll();
        paint();
      }));
      listBox.appendChild(line);

      if (!(cfg.fallbacks || []).length) {
        listBox.appendChild(el('div', 'bncm-fm-note', { text: '（当前没有回退字体，字体栈里只有基础字体族）' }));
      }
      (cfg.fallbacks || []).forEach(function (f, i) {
        var r = el('div', 'bncm-fm-fb');
        r.appendChild(el('code', '', { text: i + '. ' + f }));
        r.appendChild(button('↑', function () {
          if (i === 0) return;
          var next = cfg.fallbacks.slice();
          var tmp = next[i - 1]; next[i - 1] = next[i]; next[i] = tmp;
          cfg.fallbacks = next; Preferences.write('fallbacks', next); applyAll(); paint();
        }));
        r.appendChild(button('↓', function () {
          if (i >= cfg.fallbacks.length - 1) return;
          var next = cfg.fallbacks.slice();
          var tmp = next[i + 1]; next[i + 1] = next[i]; next[i] = tmp;
          cfg.fallbacks = next; Preferences.write('fallbacks', next); applyAll(); paint();
        }));
        r.appendChild(button('删除', function () {
          var next = cfg.fallbacks.slice();
          next.splice(i, 1);
          cfg.fallbacks = next; Preferences.write('fallbacks', next); applyAll(); paint();
        }));
        listBox.appendChild(r);
      });
    }
    paint();
    runtime.sections.fallbacks = paint;
    return sec;
  }

  function sectionPreview() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '9. 实时预览' }));
    runtime.preview = buildPreview();
    sec.appendChild(runtime.preview.root);
    return sec;
  }

  function sectionSync() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '2. 字号与原生事件同步' }));
    var subscribed = !!(window.legacyNativeCmder &&
      typeof window.legacyNativeCmder.appendRegisterCall === 'function');
    sec.appendChild(el('div', '', {
      text: subscribed
        ? '已订阅 legacyNativeCmder.appendRegisterCall("FontSize","player",cb)：当客户端或桌面歌词窗口改变字号时，歌词字号会同步更新并立即生效。'
        : '当前桥未暴露 legacyNativeCmder.appendRegisterCall，无法订阅原生字号事件；面板不会自动同步外部字号变化（其他功能不受影响）。'
    }));
    sec.appendChild(el('div', 'bncm-fm-note', {
      text: '注意：原生注册表是「同名覆盖」语义，本插件会占用 FontSize 这一个回调名。'
    }));
    return sec;
  }

  function sectionDiagnostics() {
    var sec = el('div', 'bncm-fm-sec');
    sec.appendChild(el('h4', '', { text: '8. 一键恢复默认 / 诊断' }));

    function summaryText() {
      var snap = ensureSnapshot() || {};
      var lines = [];
      lines.push('快照采集时间 : ' + (snap.capturedAt || '?'));
      lines.push('快照来源     : lyricFont = ' + (snap.lyricFontSource || '?'));
      lines.push('body 字体来源: ' + (snap.bodyFontFamilySource || '?') + ' / ' + (snap.bodyFontSizeSource || '?'));
      return lines.join('\n');
    }

    var out = el('pre', '', { text: summaryText() + '\n\n（选择下面的按钮查看诊断输出）' });
    sec.appendChild(out);

    sec.appendChild(row('', [
      button('恢复默认字体', function () {
        var ok = window.confirm('恢复默认将：\n' +
          '· 把原生字体重置为「默认」（player.setFont / player.setLRCFont）\n' +
          '· 移除本插件注入的样式\n' +
          '· 清空本插件保存的配置（localStorage + config.json）\n\n' +
          '字体快照会保留，方便随时对照。继续？');
        if (!ok) return;
        out.textContent = '正在恢复…';
        restoreDefaults().then(function (done) {
          afterRestore();
          out.textContent = done
            ? '已恢复默认。\n\n' + summaryText() + '\n\n改动任意控件即可重新应用字体；所有警告已清空。'
            : '恢复默认失败，详见上方警告。';
        });
      }),
      button('对比快照（诊断）', function () {
        var snap = ensureSnapshot() || {};
        var rows = snapshotDiff(cfg);
        var lines = [summaryText(), ''];
        lines.push('key                  snapshot              current               same');
        rows.forEach(function (r) {
          lines.push(String(r.key).padEnd(20) + ' ' + String(r.snapshot).slice(0, 20).padEnd(21) +
            String(r.current).slice(0, 20).padEnd(21) + (r.same ? 'yes' : 'NO'));
        });
        lines.push('');
        lines.push('说明：网易云客户端没有暴露「读取当前桌面歌词字体」的命令（每个字段只有 setter，');
        lines.push('没有 getter），所以 lyricFont 只能记录本插件最后一次设置的值，或首次启用时');
        lines.push('的客户端默认值。这里不做真实读回，诊断中如实标注，不假装成功。');
        out.textContent = lines.join('\n');
      }),
      button('自检（原生命令可用性）', function () {
        out.textContent = '检测中…';
        var lines = [];
        querySystemFonts().then(function (list) {
          lines.push('[os.querySystemFonts] ' + (list.length
            ? 'success，' + list.length + ' 个字体族'
            : '未返回数据（已回退到内置列表 + 自由输入）'));
          return checkNativeSupportFonts(CURATED_PROBE);
        }).then(function (ok) {
          lines.push('[os.checkNativeSupportFonts] ' + (ok.length
            ? 'success，命中 ' + ok.join(' / ')
            : '未返回数据（内置列表可用性未知，请以自由输入为准）'));
          return nativeCall('player.setFont', cfg.uiFamily || cfg.lyricFontDefault, cfg.uiSize);
        }).then(function () {
          lines.push('[player.setFont] 已通过 bridge 调用（该命令无返回值，属正常）');
          return nativeCall('player.setLRCFont', cfg.lyricSize, cfg.lyricStyle, cfg.lyricFamily || cfg.lyricFontDefault);
        }).then(function () {
          lines.push(lyricOwner() ? '[player.setLRCFont] 已让位给 ' + lyricOwner() :
            '[player.setLRCFont] 已通过 bridge 调用（该命令无返回值，属正常）');
          lines.push('');
          lines.push('betterncm.ncm.call : ' + (ncmApi && typeof ncmApi.call === 'function' ? '可用' : '不可用'));
          lines.push('window.channel     : ' + (window.channel && typeof window.channel.call === 'function' ? '可用' : '不可用'));
          lines.push('FontSize 订阅      : ' + (window.legacyNativeCmder &&
            typeof window.legacyNativeCmder.appendRegisterCall === 'function' ? '已注册' : '桥未暴露'));
          lines.push('上次原生应用       : ' + (lastNativeApply
            ? new Date(lastNativeApply.at).toLocaleTimeString() + ' · setFont(' + lastNativeApply.font + ', ' +
              lastNativeApply.size + ') · setLRCFont(' + lastNativeApply.lyricSize + ', ' +
              lastNativeApply.lyricStyle + ', ' + lastNativeApply.lyricFont + ')'
            : '（尚未）'));
          lines.push('持久化             : localStorage["' + LS_NS + '"] + config.json[' + CFG_PREFIX + '*]');
          lines.push('注入样式元素       : ' + (document.getElementById(STYLE_ID) ? '存在' : '不存在'));
          out.textContent = lines.join('\n');
        });
      })
    ]));
    return sec;
  }

  /* ------------------------------------------------------------------ panel assembly */

  function fillFontList(datalist, note) {
    datalist.textContent = '';
    var seen = {};
    offerableFamilies('cjk').concat(offerableFamilies('latin')).forEach(function (f) {
      if (seen[f]) return;
      seen[f] = 1;
      var o = document.createElement('option');
      o.value = f;
      datalist.appendChild(o);
    });
    var text = fontState.system.length
      ? '已读取到 ' + fontState.system.length + ' 个系统已安装字体，字体族下拉菜单即取自该列表。' +
        '列表中没有的字体族可用「自定义…」手动输入。'
      : '未能读取系统字体列表——字体族请用「自定义…」手动输入。';
    if (fontState.cjkChecked.length) {
      text += '（内置 CJK 探测命中 ' + fontState.cjkChecked.length + ' 个）';
    }
    if (fontState.queryError) {
      text += ' 注意：' + fontState.queryError + '。';
    }
    note.textContent = text;
  }

  function buildPanel() {
    panelCss();
    runtime.sections = {};
    var root = el('div', '', { id: PANEL_ID });

    panelWarningBox = el('div', 'bncm-fm-sec bncm-fm-warn');
    root.appendChild(panelWarningBox);
    renderWarnings();

    root.appendChild(sectionLimit());

    var listNote = el('div', 'bncm-fm-note', { text: '正在读取系统字体列表…' });
    var datalist = document.createElement('datalist');
    datalist.id = LIST_ID;
    root.appendChild(datalist);
    root.appendChild(listNote);
    loadFontsOnce().then(function () {
      fillFontList(datalist, listNote);
      // The panel is built synchronously but the installed font list arrives over the bridge, so
      // every family dropdown is refilled once the real list is known.
      refreshFamilyControls();
    }, function () {
      fillFontList(datalist, listNote);
    });

    root.appendChild(sectionUi());
    root.appendChild(sectionBody());
    root.appendChild(sectionLyric());
    root.appendChild(sectionLatin());
    root.appendChild(sectionFallbacks());
    root.appendChild(sectionPreview());
    root.appendChild(sectionSync());
    root.appendChild(sectionDiagnostics());

    paintPreview();
    return root;
  }

  /* ------------------------------------------------------------------ FontSize subscription */

  function subscribeFontSize() {
    try {
      var lc = window.legacyNativeCmder;
      if (!lc || typeof lc.appendRegisterCall !== 'function') {
        // Not fatal: the panel simply will not mirror externally driven size changes.
        firstWarn('legacyNativeCmder.appendRegisterCall 不可用——面板不会同步原生命令驱动的字号变化。');
        return false;
      }
      lc.appendRegisterCall('FontSize', 'player', function (size) {
        if (lyricOwner()) return;
        if (typeof size !== 'number' || !isFinite(size)) return;
        try {
          /* The client reports the desktop-lyric size through this event and it is the only size it
           * reports back, so it drives lyricSize.  Apply directly instead of going through the
           * debounced pipeline, and keep the panel input in sync. */
          runtime.suppressApplyAll = true;
          cfg.lyricSize = size;
          Preferences.write('lyricSize', size);
          addMarkerClass();
          applyCss(cfg);
          paintPreview();
          writeApplied({ lyricFontSize: size });
          runtime.suppressApplyAll = false;
          nativeCall('player.setLRCFont', cfg.lyricSize, cfg.lyricStyle, cfg.lyricFamily || cfg.lyricFontDefault);
          if (runtime.panel) {
            var input = runtime.panel.querySelector('input[data-bncm-fm="lyricSize"]');
            if (input && String(input.value) !== String(size)) input.value = String(size);
          }
        } catch (e) {
          runtime.suppressApplyAll = false;
          firstWarn('处理 FontSize 事件失败：' + (e && e.message ? e.message : e));
        }
      });
      return true;
    } catch (e) {
      firstWarn('订阅 FontSize 事件失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /* ------------------------------------------------------------------ lifecycle */

  var protectedRootSelector = LYRIC_SELECTORS.join(',');
  var lyricObserver = null;
  function markLyricRoots(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.closest('[data-bncm-fm-lyrics-owned]')) return;
    if (root.matches(protectedRootSelector)) {
      root.setAttribute('data-bncm-fm-lyrics-owned', '');
      return;
    }
    Array.prototype.forEach.call(root.querySelectorAll(protectedRootSelector), function (node) {
      if (!node.parentElement.closest('[data-bncm-fm-lyrics-owned]')) node.setAttribute('data-bncm-fm-lyrics-owned', '');
    });
  }
  function syncLyricProtection() {
    if (lyricOwner()) {
      markLyricRoots(document.body);
      if (!lyricObserver && document.body) {
        lyricObserver = new MutationObserver(function (records) {
          records.forEach(function (record) {
            if (record.target.nodeType === 1 && record.target.closest('[data-bncm-fm-lyrics-owned]')) return;
            Array.prototype.forEach.call(record.addedNodes, markLyricRoots);
          });
        });
        lyricObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      clearLyricProtection();
    }
  }
  function clearLyricProtection() {
    if (lyricObserver) { lyricObserver.disconnect(); lyricObserver = null; }
    Array.prototype.forEach.call(document.querySelectorAll('[data-bncm-fm-lyrics-owned]'), function (node) {
      node.removeAttribute('data-bncm-fm-lyrics-owned');
    });
  }

  function lyricStatusText() {
    var owner = lyricOwner();
    return owner ? '检测到 ' + owner + ' 控制歌词字体，已暂停本插件的歌词字体、字重及原生歌词设置。UI / 正文设置仍生效。' :
      '未检测到其他歌词字体控制，本插件的歌词设置生效。';
  }
  var lastLyricOwner = lyricOwner();
  function refreshLyricOwner() {
    var owner = lyricOwner();
    if (owner === lastLyricOwner) return;
    lastLyricOwner = owner;
    lastLyricRequest = '';
    syncLyricProtection();
    if (!runtime.suppressApplyAll && document.getElementById(STYLE_ID)) {
      applyCss(cfg);
      if (!owner) applyToClient(cfg);
    }
    if (runtime.panel) {
      var status = runtime.panel.querySelector('[data-bncm-fm-lyric-owner]');
      if (status) status.textContent = lyricStatusText();
    }
  }
  var ownerTimer = setInterval(refreshLyricOwner, 1000);

  function boot() {
    try {
      ensureSnapshot();          // BEFORE the first apply, so our CSS cannot contaminate it
      cfg = Preferences.readAll();
      /* First paint immediately from the fast synchronous read, then re-apply once the durable
       * data-dir copies arrive (they win on precedence). */
      addMarkerClass();
      applyCss(cfg);
      paintPreview();
      applyToClient(cfg);
      Preferences.hydrateFromApp(cfg).then(function (hydrated) {
        cfg = hydrated;
        addMarkerClass();
        applyCss(cfg);
        paintPreview();
        applyToClient(cfg);
      }, function () { /* first paint already applied */ });
      subscribeFontSize();
      log('v' + VERSION + ' loaded · system fonts:', fontState.system.length, '· cfg:', cfg);
    } catch (e) {
      // Never throw out of onLoad.
      firstWarn('初始化失败：' + (e && e.message ? e.message : e));
    }
  }

  // <body> may not exist yet when the plugin script is injected.
  try {
    if (document.body) boot();
    else if (typeof utils.waitForElement === 'function') {
      Promise.resolve(utils.waitForElement('body', 100)).then(boot, boot);
    } else if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else boot();
  } catch (e) {
    firstWarn('启动失败：' + (e && e.message ? e.message : e));
  }

  /* ------------------------------------------------------------------ plugin registration */

  try {
    var plugin = window.plugin;
    if (!plugin || typeof plugin.onConfig !== 'function') {
      firstWarn('window.plugin 或 plugin.onConfig 不可用——兼容层未注入，配置面板不会出现（样式与原生字体仍已应用）。');
    } else {
      plugin.onConfig(function () {
        try {
          runtime.panel = buildPanel();
          return runtime.panel;
        } catch (e) {
          firstWarn('配置面板构建失败：' + (e && e.message ? e.message : e));
          // Must still return an element, or the host has nothing to show.
          runtime.panel = el('div', 'padding:8px', {
            text: 'NCM Font Manager 配置面板构建失败，请查看控制台。字体本身仍然已生效。'
          });
          return runtime.panel;
        }
      });
    }
  } catch (e) {
    firstWarn('注册配置面板失败：' + (e && e.message ? e.message : e));
  }

  /* ------------------------------------------------------------------ teardown handle */

  window.__BNCM_NCM_FONT_MANAGER__ = {
    version: VERSION,
    get config() { return cfg; },
    get warnings() { return warnings.slice(); },
    get lyricOwner() { return lyricOwner(); },
    dispose: function () {
      clearInterval(ownerTimer);
      cancelScheduledApply();
      clearLyricProtection();
      runtime.suppressApplyAll = true;
      try { removeCss(); } catch (e) { /* ignore */ }
      try { removeMarkerClass(); } catch (e) { /* ignore */ }
      var pcss = document.getElementById(PANEL_CSS_ID);
      if (pcss && pcss.parentNode) pcss.parentNode.removeChild(pcss);
      runtime.panel = null;
      runtime.preview = null;
      runtime.sections = {};
      panelWarningBox = null;
      runtime.suppressApplyAll = false;
    },
    /** Internals exposed for inspection/testing from the page console. */
    _internals: {
      DEFAULT_CONFIG: DEFAULTS,
      buildCss: buildCss,
      lyricOwner: lyricOwner,
      refreshLyricOwner: refreshLyricOwner,
      applyToClient: applyToClient,
      syncLyricProtection: syncLyricProtection,
      stackFor: stackFor,
      unicodeRange: unicodeRange,
      quoteFamily: quoteFamily,
      bridgePayload: bridgePayload,
      captureSnapshot: captureSnapshot,
      snapshotDiff: snapshotDiff,
      offerableFamilies: offerableFamilies,
      querySystemFonts: querySystemFonts,
      checkNativeSupportFonts: checkNativeSupportFonts,
      fontState: fontState,
      restoreDefaults: restoreDefaults
    }
  };
})();
